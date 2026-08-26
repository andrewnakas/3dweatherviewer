// GLSL for the 3D storm-cell layer: each lattice cell with a radar echo draws
// a translucent camera-facing curtain from the ground up to the cell's real
// echo-top height, banded in the radar dBZ colors. This is the radar volume —
// storm towers standing in the atmosphere where the model puts them, rather
// than paint on the terrain.

import { TERRAIN_GLSL } from "./shaders.js";

export const STORM_VERT = `#version 300 es
precision highp float;

uniform mat4 u_matrix;
uniform float u_west;
uniform float u_north;
uniform float u_lonSpan;
uniform float u_latSpan;
uniform float u_altMerc;    // mercator z per metre above ground
uniform float u_m2merc;     // mercator units per horizontal metre
uniform int u_grid;
uniform vec2 u_cell;        // lattice cell size, normalized domain units
uniform vec2 u_ic0;
uniform vec3 u_camRight;    // horizontal ENU right vector of the screen
uniform float u_ambient;
uniform vec2 u_camPos;
uniform float u_camAlt;
uniform float u_occlude;
uniform float u_fadeNear;   // km
uniform float u_fadeFar;

// weather atlas radar tile: R reflectivity, G echo top, B VIL
uniform sampler2D u_wxA;
uniform sampler2D u_wxB;
uniform float u_wxMix;
uniform vec2 u_wxTileScale;
uniform vec2 u_wxClampMin;
uniform vec2 u_wxClampMax;
uniform vec2 u_radarOff;
uniform vec2 u_cloudOff;    // cloud tile: G = cloud base (m ASL, 0 = none)
uniform vec2 u_precipOff;   // precip tile: R = surface rate (sqrt mm/h)
uniform float u_topMax;     // echoTop linear-encoding max (m)
uniform float u_vilMax;     // VIL sqrt-encoding max (kg/m^2)
uniform float u_baseMax;    // cloudBase linear-encoding max (m)
uniform float u_rateMax;    // precipRate sqrt-encoding max (mm/h)

out vec2 v_uv;              // x: -1..1 across, y: 0..1 ground->top
out float v_dbz;
out float v_vil;
out float v_alpha;
out float v_seed;
out float v_baseFrac;       // cloud base as a fraction of the column height
out float v_rain;           // 0..1: is precip actually reaching the ground?

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

void collapse() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); v_alpha = 0.0; }

void main() {
  int pid = gl_VertexID / 6;
  int corner = gl_VertexID - pid * 6;
  vec2 c = corner == 0 ? vec2(-1, 0) : corner == 1 ? vec2(1, 0) : corner == 2 ? vec2(1, 1)
         : corner == 3 ? vec2(-1, 0) : corner == 4 ? vec2(1, 1) : vec2(-1, 1);
  v_uv = c;

  vec2 ic = u_ic0 + vec2(float(pid % u_grid), float(pid / u_grid));
  vec2 jitterKey = ic * 1.618;
  vec2 pos = (ic + 0.35 + 0.3 * vec2(hash12(jitterKey), hash12(jitterKey + 5.1))) * u_cell;
  if (pos.x < 0.0 || pos.x > 1.0 || pos.y < 0.0 || pos.y > 1.0) { collapse(); return; }
  v_seed = hash12(jitterKey + 9.7);

  vec2 uv = u_radarOff + clamp(pos, u_wxClampMin, u_wxClampMax) * u_wxTileScale;
  vec4 rad = mix(texture(u_wxA, uv), texture(u_wxB, uv), u_wxMix);
  if (rad.a < 0.5) { collapse(); return; }
  v_dbz = -10.0 + max(rad.r * 255.0 - 1.0, 0.0) / 254.0 * 85.0;
  float topASL = max(rad.g * 255.0 - 1.0, 0.0) / 254.0 * u_topMax;
  v_vil = rad.b * rad.b * u_vilMax;
  // Only real echoes stand up as towers; weak returns stay with the drape.
  if (v_dbz < 18.0 || rad.g * 255.0 < 0.5) { collapse(); return; }

  float terr = terrainHeight(pos);
  float topAgl = topASL - terr;
  if (topAgl < 400.0) { collapse(); return; }

  // The storm's own vertical placement: the volume lives between this cell's
  // cloud base and its echo top. Below the base only a rain shaft carries
  // signal, and only where surface precip actually falls — an elevated echo
  // floats at its real height instead of standing on the terrain.
  vec2 cuv = u_cloudOff + clamp(pos, u_wxClampMin, u_wxClampMax) * u_wxTileScale;
  float baseByte = mix(texture(u_wxA, cuv), texture(u_wxB, cuv), u_wxMix).g;
  float baseAgl = baseByte * u_baseMax - terr; // infilled, plain linear
  v_baseFrac = clamp(baseAgl / topAgl, 0.0, 0.85);
  vec2 puv = u_precipOff + clamp(pos, u_wxClampMin, u_wxClampMax) * u_wxTileScale;
  float rateN = mix(texture(u_wxA, puv), texture(u_wxB, puv), u_wxMix).r;
  float rate = rateN * rateN * u_rateMax; // mm/h
  v_rain = smoothstep(0.05, 2.0, rate);

  float latP = u_north - pos.y * u_latSpan;
  float cellM = max(u_cell.x * u_lonSpan * 111320.0 * cos(radians(latP)),
                    u_cell.y * u_latSpan * 110540.0);
  float halfW = cellM * 0.62;

  float lon = u_west + pos.x * u_lonSpan;
  float mx = (lon + 180.0) / 360.0;
  float sm = clamp(sin(radians(latP)), -0.9999, 0.9999);
  float my = 0.5 - 0.25 * log((1.0 + sm) / (1.0 - sm)) / PI;

  // Vertical curtain that yaws to face the camera: horizontal screen-right
  // spans the width, world-up spans ground -> echo top.
  vec3 off = u_camRight * (c.x * halfW);
  vec3 world = vec3(mx + off.x * u_m2merc,
                    my - off.y * u_m2merc,
                    c.y * topAgl * u_altMerc);
  gl_Position = u_matrix * vec4(world, 1.0);

  float fade = 1.0;
  float dLon = (pos.x - u_camPos.x) * u_lonSpan * 111320.0 * cos(radians(latP));
  float dLat = (pos.y - u_camPos.y) * u_latSpan * 110540.0;
  float km = length(vec2(dLon, dLat)) / 1000.0;
  fade = 1.0 - smoothstep(u_fadeNear, u_fadeFar, km);
  if (u_occlude > 0.5 && fade > 0.0) {
    // occlusion tested at the tower's mid height
    float pz = terr + topAgl * 0.4;
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

  v_alpha = fade * (0.5 + 0.5 * u_ambient);
  if (v_alpha < 0.004) collapse();
}`;

export const STORM_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
in float v_dbz;
in float v_vil;
in float v_alpha;
in float v_seed;
in float v_baseFrac;
in float v_rain;
out vec4 outColor;

uniform float u_opacity;

// NWS-style banded reflectivity colors, matching the 2D drape's ramp.
const vec3 DBZ[15] = vec3[15](
  vec3(0.016, 0.914, 0.906), vec3(0.004, 0.624, 0.957), vec3(0.012, 0.000, 0.957),
  vec3(0.008, 0.992, 0.008), vec3(0.004, 0.773, 0.004), vec3(0.000, 0.557, 0.000),
  vec3(0.992, 0.973, 0.008), vec3(0.898, 0.737, 0.000), vec3(0.992, 0.584, 0.000),
  vec3(0.992, 0.000, 0.000), vec3(0.831, 0.000, 0.000), vec3(0.737, 0.000, 0.000),
  vec3(0.973, 0.000, 0.992), vec3(0.596, 0.329, 0.776), vec3(1.000, 1.000, 1.000)
);

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
  // Reflectivity weakens toward the echo top; color the curtain by the local
  // dBZ so a 55 dBZ core reads red low down and runs smoothly through the
  // ramp with height.
  float dbzHere = v_dbz * (1.0 - 0.55 * v_uv.y * v_uv.y);
  float bandF = clamp((dbzHere - 5.0) / 5.0, 0.0, 14.0);
  int b0 = int(bandF);
  vec3 color = mix(DBZ[b0], DBZ[min(b0 + 1, 14)], smoothstep(0.2, 0.8, fract(bandF)));

  // ragged sides and top, seeded per tower; the column tapers with height so
  // a cell reads as a storm core, not a slab
  vec2 np = vec2(v_uv.x * 2.2, v_uv.y * 3.0) + v_seed * 41.0;
  float noise = 0.6 * vnoise(np) + 0.4 * vnoise(np * 2.6 + 7.0);
  float taper = 0.85 + 0.5 * v_uv.y;
  float side = smoothstep(1.0, 0.45, abs(v_uv.x) * taper + (noise - 0.5) * 0.5);
  float top = smoothstep(1.02, 0.82, v_uv.y + (noise - 0.5) * 0.14);
  // denser cores: scale with VIL so a juicy cell reads solid
  float density = 0.16 + 0.2 * clamp(v_vil / 25.0, 0.0, 1.0);

  // vertical placement: full volume from the cell's cloud base up to the
  // echo top; below the base only a thinner rain shaft, and only where rain
  // is actually reaching the ground
  float aboveBase = smoothstep(v_baseFrac - 0.06, v_baseFrac + 0.02, v_uv.y);
  float profile = max(aboveBase, v_rain * 0.45 * (1.0 - aboveBase));

  float a = v_alpha * side * top * density * profile * u_opacity;
  outColor = vec4(color, 1.0) * a;
}`;
