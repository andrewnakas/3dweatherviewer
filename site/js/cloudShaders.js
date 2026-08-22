// GLSL for the billboard cloud layer. Stateless: every puff is derived per
// frame from gl_VertexID (6 vertices per puff), pinned to an absolute
// world-space lattice so panning doesn't make clouds swim. A puff lives where
// the weather atlas says cloud lives: between cloud base and top, accepted
// with probability set by cover fraction and the condensate column.

import { TERRAIN_GLSL } from "./shaders.js";

export const QC_LEVELS = 12; // condensate tiles in the weather atlas

export const CLOUD_VERT = `#version 300 es
precision highp float;

uniform mat4 u_matrix;
uniform float u_west;
uniform float u_north;
uniform float u_lonSpan;
uniform float u_latSpan;
uniform float u_altMerc;    // mercator z per metre above ground
uniform float u_m2merc;     // mercator units per horizontal metre
uniform int u_grid;         // lattice columns (G x G cells)
uniform int u_layers;       // vertical slots per cell
uniform vec2 u_cell;        // lattice cell size, normalized domain units
uniform vec2 u_ic0;         // integer cell coords of the lattice origin
uniform vec3 u_camRight;    // ENU unit vectors spanning the screen plane
uniform vec3 u_camUp;
uniform vec3 u_sunDir;      // ENU, toward the sun
uniform vec3 u_sunColor;
uniform float u_ambient;
uniform float u_density;    // user cloud-density control, ~1
uniform vec2 u_camPos;
uniform float u_camAlt;
uniform float u_occlude;
uniform float u_fadeNear;   // km
uniform float u_fadeFar;

// weather atlas
uniform sampler2D u_wxA;
uniform sampler2D u_wxB;
uniform float u_wxMix;
uniform vec2 u_wxTileScale;
uniform vec2 u_wxClampMin;
uniform vec2 u_wxClampMax;
uniform vec2 u_cloudOff;
uniform vec2 u_layersOff;
uniform float u_hMax;       // cloudBase/cloudTop linear max (m)
uniform float u_qcMax;      // qc sqrt-encoding max (kg/kg)
uniform vec2 u_qcOff[${QC_LEVELS}];
uniform float u_qcHeight[${QC_LEVELS}];
uniform int u_qcLen;

out vec2 v_uv;
out vec3 v_color;
out float v_alpha;
out float v_seed;

const float PI = 3.141592653589793;

${TERRAIN_GLSL}

float terrainHeight(vec2 pos) {
  return u_hasTerrHi > 0.5 ? terrainHeightHi(pos) : 0.0;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec4 wxTile(vec2 off, vec2 pos) {
  vec2 uv = off + clamp(pos, u_wxClampMin, u_wxClampMax) * u_wxTileScale;
  return mix(texture(u_wxA, uv), texture(u_wxB, uv), u_wxMix);
}

// byte-0-sentinel linear decode of a normalized channel
float decodeZ(float g, float vmax) {
  return max(g * 255.0 - 1.0, 0.0) / 254.0 * vmax;
}

// cloud condensate (kg/kg) interpolated from the 12-level column at h m ASL
float qcAt(vec2 pos, float h) {
  int lo = 0;
  for (int k = 0; k < ${QC_LEVELS}; k++) {
    if (k >= u_qcLen) break;
    if (u_qcHeight[k] <= h) lo = k;
  }
  int hi = min(lo + 1, u_qcLen - 1);
  float f = u_qcHeight[hi] > u_qcHeight[lo] + 1.0
    ? clamp((h - u_qcHeight[lo]) / (u_qcHeight[hi] - u_qcHeight[lo]), 0.0, 1.0)
    : 0.0;
  float qa = wxTile(u_qcOff[lo], pos).r;
  float qb = wxTile(u_qcOff[hi], pos).r;
  float q = mix(qa, qb, f);
  return q * q * u_qcMax;
}

void collapse() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); v_alpha = 0.0; }

void main() {
  int pid = gl_VertexID / 6;
  int corner = gl_VertexID - pid * 6;
  // quad corners: two triangles
  vec2 c = corner == 0 ? vec2(-1, -1) : corner == 1 ? vec2(1, -1) : corner == 2 ? vec2(1, 1)
         : corner == 3 ? vec2(-1, -1) : corner == 4 ? vec2(1, 1) : vec2(-1, 1);
  v_uv = c;

  int perLayer = u_grid * u_grid;
  int layer = pid / perLayer;
  int cellId = pid - layer * perLayer;
  vec2 ic = u_ic0 + vec2(float(cellId % u_grid), float(cellId / u_grid));

  // jitter within the cell, keyed to the ABSOLUTE cell so panning is stable
  vec2 jitterKey = ic + float(layer) * 917.0;
  vec2 pos = (ic + 0.2 + 0.6 * vec2(hash12(jitterKey), hash12(jitterKey + 41.7))) * u_cell;
  if (pos.x < 0.0 || pos.x > 1.0 || pos.y < 0.0 || pos.y > 1.0) { collapse(); return; }
  v_seed = hash12(jitterKey + 7.7);

  vec4 cl = wxTile(u_cloudOff, pos);
  if (cl.a < 0.5) { collapse(); return; }
  float cover = cl.r;                       // 0..1 (percent/100 -> byte/255)
  float base = decodeZ(cl.g, u_hMax);
  float top = decodeZ(cl.b, u_hMax);
  if (cover < 0.03 || top <= base + 60.0) { collapse(); return; }

  // vertical slot inside [base, top]
  float s = (float(layer) + hash12(jitterKey + 3.3)) / float(u_layers);
  float h = mix(base, top, s);

  // which cover band is this height in? low <3 km, mid 3-6, high >6 (ASL)
  vec4 lmh = wxTile(u_layersOff, pos);
  float wLow = 1.0 - smoothstep(2500.0, 3500.0, h);
  float wHigh = smoothstep(5000.0, 7000.0, h);
  float wMid = clamp(1.0 - wLow - wHigh, 0.0, 1.0);
  float band = lmh.r * wLow + lmh.g * wMid + lmh.b * wHigh;
  float coverEff = max(band, cover * 0.55);

  // condensate makes the honest 3D structure; keep a floor so shallow
  // stratus below the lowest condensate level still shows
  float qf = clamp(qcAt(pos, h) / 3.5e-4, 0.0, 1.0);
  float p = coverEff * (0.35 + 0.65 * qf) * u_density;
  float roll = hash12(jitterKey + 11.3);
  if (roll > p) { collapse(); return; }
  // soft edge: puffs that barely made the cut are wispier
  float edge = smoothstep(0.0, 0.25 * p, p - roll);

  float terr = terrainHeight(pos);
  float zAgl = max(h - terr, 120.0);

  // puff radius: scaled to the depth of the deck and the lattice spacing so
  // zoomed-out views close into sheets instead of leaving gaps
  float latP = u_north - pos.y * u_latSpan;
  float cellM = max(u_cell.x * u_lonSpan * 111320.0 * cos(radians(latP)),
                    u_cell.y * u_latSpan * 110540.0);
  float depth = clamp((top - base) / 3000.0, 0.4, 1.6);
  float radius = mix(500.0, 1500.0, hash12(jitterKey + 23.1)) * depth;
  radius = clamp(max(radius, cellM * 0.42), 250.0, 26000.0);

  float lon = u_west + pos.x * u_lonSpan;
  float mx = (lon + 180.0) / 360.0;
  float sm = clamp(sin(radians(latP)), -0.9999, 0.9999);
  float my = 0.5 - 0.25 * log((1.0 + sm) / (1.0 - sm)) / PI;

  // billboard in ENU, then ENU -> mercator (x=east, y=-north, z=up)
  vec3 off = (u_camRight * c.x + u_camUp * c.y) * radius;
  vec3 world = vec3(mx + off.x * u_m2merc,
                    my - off.y * u_m2merc,
                    zAgl * u_altMerc + off.z * u_altMerc);
  gl_Position = u_matrix * vec4(world, 1.0);

  // range fade + terrain occlusion of the puff centre
  float fade = 1.0;
  float dLon = (pos.x - u_camPos.x) * u_lonSpan * 111320.0 * cos(radians(latP));
  float dLat = (pos.y - u_camPos.y) * u_latSpan * 110540.0;
  float km = length(vec2(dLon, dLat)) / 1000.0;
  fade = 1.0 - smoothstep(u_fadeNear, u_fadeFar, km);
  // don't whiteout when the camera is inside the puff
  fade *= smoothstep(radius * 0.6 / 1000.0, radius * 1.8 / 1000.0, km + abs(u_camAlt - (terr + zAgl)) / 1000.0);
  if (u_occlude > 0.5 && fade > 0.0) {
    float pz = terr + zAgl;
    vec2 toCam = u_camPos - pos;
    for (int i = 1; i <= 10; i++) {
      float t = float(i) / 11.0;
      t = t * t;
      if (terrainHeight(pos + toCam * t) > mix(pz, u_camAlt, t) + 60.0) {
        fade = 0.0;
        break;
      }
    }
  }

  // lighting: pseudo-sphere normal on the screen plane, lit in ENU
  vec3 viewBack = normalize(cross(u_camRight, u_camUp));
  vec3 n = normalize(u_camRight * c.x * 0.6 + u_camUp * c.y * 0.6 + viewBack);
  float diffuse = max(dot(n, u_sunDir), 0.0);
  float sunUp = clamp(u_sunDir.z, 0.0, 1.0);
  float vshade = mix(0.72, 1.05, s);  // darker toward the deck's base
  vec3 lit = (u_ambient * 0.55 + diffuse * 0.6 * sunUp) * u_sunColor;
  v_color = clamp(lit * vshade, 0.0, 1.4) * vec3(0.98, 0.99, 1.0);
  v_alpha = 0.28 * fade * edge;
  if (v_alpha < 0.004) collapse();
}`;

export const CLOUD_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
in vec3 v_color;
in float v_alpha;
in float v_seed;
out vec4 outColor;

uniform float u_opacity;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;
  // broken cauliflower edge: two octaves of value noise, seeded per puff
  vec2 np = v_uv * 3.0 + v_seed * 37.0;
  float noise = 0.65 * vnoise(np) + 0.35 * vnoise(np * 2.7 + 11.0);
  float body = smoothstep(1.0, 0.25, d + (noise - 0.5) * 0.55);
  float a = v_alpha * body * u_opacity;
  outColor = vec4(v_color, 1.0) * a;
}`;
