// GLSL for the falling-precipitation particle system (float state only —
// precip is decorative, so GPUs without float render targets just skip it).
//
// State (ping-ponged MRT):
//   pos: (x, y, zAglMeters, 0)   xy in normalized domain coords, z above ground
//   aux: (ageSeconds, seed, flutterPhase, alphaScale)
//
// Weather atlas tiles sampled (see pipeline/config.py):
//   precip: R rate sqrt-encoded, G frozen fraction, B freezing-bucket flag
//   cloud:  G cloud base (m ASL, byte 0 = none)
// Wind advection comes from the WIND atlas's 10 m / 80 m tiles.

import { TERRAIN_GLSL } from "./shaders.js";

export { QUAD_VERT } from "./shaders.js";

const WX_COMMON = `
uniform sampler2D u_wxA;
uniform sampler2D u_wxB;
uniform float u_wxMix;
uniform vec2 u_wxTileScale;
uniform vec2 u_wxClampMin;
uniform vec2 u_wxClampMax;
uniform vec2 u_precipOff;
uniform vec2 u_cloudOff;
uniform float u_rateMax;      // precipRate sqrt-encoding max (mm/h)
uniform float u_baseMax;      // cloudBase linear-encoding max (m)

vec4 wxTile(vec2 off, vec2 pos) {
  vec2 uv = off + clamp(pos, u_wxClampMin, u_wxClampMax) * u_wxTileScale;
  return mix(texture(u_wxA, uv), texture(u_wxB, uv), u_wxMix);
}

// rate mm/h, frozen fraction 0..1, freezing-bucket flag, domain validity
vec4 precipAt(vec2 pos) {
  vec4 t = wxTile(u_precipOff, pos);
  return vec4(t.r * t.r * u_rateMax, t.g, t.b, t.a);
}

// Cloud base m ASL; byte-0 sentinel decodes ~0 which the caller floors away.
float cloudBaseAt(vec2 pos) {
  float g = wxTile(u_cloudOff, pos).g;
  return max(g * 255.0 - 1.0, 0.0) / 254.0 * u_baseMax;
}

// Wind (m/s, earth frame) from the wind atlas 10 m / 80 m tiles, blended by
// height so upper precip drifts with the 80 m wind.
uniform sampler2D u_windA;
uniform sampler2D u_windB;
uniform float u_windMix;
uniform vec2 u_wTileScale;
uniform vec2 u_wClampMin;
uniform vec2 u_wClampMax;
uniform vec2 u_w10Off;
uniform vec4 u_w10Scale;   // uMin, uMax, vMin, vMax
uniform vec2 u_w80Off;
uniform vec4 u_w80Scale;

vec2 windAt(vec2 pos, float zAgl) {
  vec2 tl = clamp(pos, u_wClampMin, u_wClampMax) * u_wTileScale;
  vec4 a10 = mix(texture(u_windA, u_w10Off + tl), texture(u_windB, u_w10Off + tl), u_windMix);
  vec4 a80 = mix(texture(u_windA, u_w80Off + tl), texture(u_windB, u_w80Off + tl), u_windMix);
  vec2 w10 = vec2(mix(u_w10Scale.x, u_w10Scale.y, a10.r), mix(u_w10Scale.z, u_w10Scale.w, a10.g));
  vec2 w80 = vec2(mix(u_w80Scale.x, u_w80Scale.y, a80.r), mix(u_w80Scale.z, u_w80Scale.w, a80.g));
  return mix(w10, w80, clamp(zAgl / 300.0, 0.0, 1.0));
}

// Fall speed (m/s, real physics scale): rain ~7-9, snow ~1.5.
float fallSpeed(float rate, float frozen) {
  float vRain = 7.0 + min(rate, 30.0) * 0.06;
  return mix(vRain, 1.5, frozen);
}

float prand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}
`;

export const PRECIP_UPDATE_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outAux;

uniform sampler2D u_statePos;
uniform sampler2D u_stateAux;
uniform float u_dt;         // wall-clock seconds this frame
uniform float u_fallGain;   // visual time compression of the fall
uniform float u_time;
uniform float u_north;
uniform float u_lonSpan;
uniform float u_latSpan;
uniform vec2 u_spawnMin;
uniform vec2 u_spawnMax;
uniform float u_maxAge;     // seconds before forced recycle

${WX_COMMON}
${TERRAIN_GLSL}

float terrainHeight(vec2 pos) {
  return u_hasTerrHi > 0.5 ? terrainHeightHi(pos) : 0.0;
}

void main() {
  vec4 sp = texture(u_statePos, v_uv);
  vec4 sa = texture(u_stateAux, v_uv);
  vec2 pos = sp.xy;
  float z = sp.z;
  float age = sa.x + u_dt;

  vec4 pcp = precipAt(pos);
  float rate = pcp.r;
  float frozen = pcp.g;

  // Advance: fall plus wind drift, both compressed by the same visual gain so
  // the slant of a streak keeps the true wind/fall ratio.
  float lat = u_north - pos.y * u_latSpan;
  vec2 wind = windAt(pos, z);
  float sdt = u_dt * u_fallGain;
  z -= fallSpeed(rate, frozen) * sdt;
  // snow flutters sideways as it falls
  wind += 0.6 * frozen * vec2(sin(u_time * 2.3 + sa.z), cos(u_time * 1.9 + sa.z * 1.7));
  float dlon = wind.x * sdt / (111320.0 * max(cos(radians(lat)), 0.05));
  float dlat = wind.y * sdt / 110540.0;
  pos += vec2(dlon / u_lonSpan, -dlat / u_latSpan);

  bool oob = pos.x < u_spawnMin.x || pos.x > u_spawnMax.x
          || pos.y < u_spawnMin.y || pos.y > u_spawnMax.y;
  bool dead = z <= 0.0 || oob || age > u_maxAge
           || (rate < 0.02 && sa.w < 0.01) || pcp.a < 0.5;

  if (dead) {
    vec2 seed = v_uv * 61.7 + fract(u_time * 0.37);
    vec2 npos = u_spawnMin + vec2(prand(seed), prand(seed.yx * 1.71)) * (u_spawnMax - u_spawnMin);
    vec4 npcp = precipAt(npos);
    float nrate = npcp.r;
    // Column top: under the local cloud base where one exists, with sane
    // bounds. cloudBase is ASL; convert to height above this ground.
    float terr = terrainHeight(npos);
    float baseAgl = cloudBaseAt(npos) - terr;
    float top = clamp(baseAgl, 700.0, 4500.0);
    if (baseAgl <= 1.0) top = 2500.0; // sentinel/no cloud: default column
    z = (0.1 + 0.9 * prand(seed * 2.13)) * top;
    pos = npos;
    age = 0.0;
    // Density control: cells with no rain get alphaScale 0 and their
    // particles die again next frame — the population concentrates where it
    // is actually raining, weighted by rate.
    float aScale = smoothstep(0.0, 1.0, sqrt(min(nrate, 20.0) / 20.0));
    if (npcp.a < 0.5) aScale = 0.0;
    outPos = vec4(pos, z, 1.0);
    outAux = vec4(age, prand(seed * 3.3), prand(seed * 5.7) * 6.28318, aScale);
    return;
  }

  outPos = vec4(pos, z, 1.0);
  outAux = vec4(age, sa.y, sa.z, sa.w);
}`;

export const PRECIP_DRAW_VERT = `#version 300 es
precision highp float;

uniform sampler2D u_statePos;
uniform sampler2D u_stateAux;
uniform int u_stateSize;
uniform mat4 u_matrix;
uniform int u_mode;          // 0 = rain streaks (LINES), 1 = snow (POINTS)
uniform float u_west;
uniform float u_north;
uniform float u_lonSpan;
uniform float u_latSpan;
uniform float u_altMerc;     // mercator z per metre above ground
uniform float u_fallGain;
uniform float u_streakSec;   // seconds of motion one streak spans
uniform float u_time;
uniform vec2 u_camPos;
uniform float u_camAlt;
uniform float u_occlude;
uniform float u_fadeNear;
uniform float u_fadeFar;
uniform float u_pixelRatio;

out float v_alpha;
out float v_frozen;
out float v_freezing;

const float PI = 3.141592653589793;

${WX_COMMON}
${TERRAIN_GLSL}

float terrainHeight(vec2 pos) {
  return u_hasTerrHi > 0.5 ? terrainHeightHi(pos) : 0.0;
}

void main() {
  int pid = u_mode == 0 ? gl_VertexID / 2 : gl_VertexID;
  int end = u_mode == 0 ? gl_VertexID - pid * 2 : 0;
  ivec2 tc = ivec2(pid % u_stateSize, pid / u_stateSize);
  vec4 sp = texelFetch(u_statePos, tc, 0);
  vec4 aux = texelFetch(u_stateAux, tc, 0);
  vec2 pos = sp.xy;
  float z = max(sp.z, 0.0);

  vec4 pcp = precipAt(pos);
  float rate = pcp.r;
  v_frozen = pcp.g;
  v_freezing = pcp.b;

  // Phase weighting: streaks carry the liquid share, flakes the frozen share.
  float phaseW = u_mode == 0 ? (1.0 - v_frozen * 0.85) : v_frozen;

  float lat = u_north - pos.y * u_latSpan;
  float terr = terrainHeight(pos);

  // Rain streak: the tail extends back up along the motion vector.
  if (u_mode == 0 && end == 1) {
    vec2 wind = windAt(pos, z);
    float span = fallSpeed(rate, v_frozen) * u_fallGain * u_streakSec;
    z += span;
    float dlon = -wind.x * u_fallGain * u_streakSec / (111320.0 * max(cos(radians(lat)), 0.05));
    float dlat = -wind.y * u_fallGain * u_streakSec / 110540.0;
    pos += vec2(dlon / u_lonSpan, -dlat / u_latSpan);
  }

  float lon = u_west + pos.x * u_lonSpan;
  float latP = u_north - pos.y * u_latSpan;
  float mx = (lon + 180.0) / 360.0;
  float sm = clamp(sin(radians(latP)), -0.9999, 0.9999);
  float my = 0.5 - 0.25 * log((1.0 + sm) / (1.0 - sm)) / PI;
  // MapLibre's matrix lifts onto the terrain; z carries height above ground.
  gl_Position = u_matrix * vec4(mx, my, z * u_altMerc, 1.0);
  gl_PointSize = (2.0 + 2.0 * fract(aux.y * 7.31)) * u_pixelRatio;

  float fade = 1.0;
  if (u_occlude > 0.5) {
    float dLon = (pos.x - u_camPos.x) * u_lonSpan * 111320.0 * cos(radians(latP));
    float dLat = (pos.y - u_camPos.y) * u_latSpan * 110540.0;
    float km = length(vec2(dLon, dLat)) / 1000.0;
    fade = 1.0 - smoothstep(u_fadeNear, u_fadeFar, km);
    // Terrain line-of-sight raymarch, same scheme as the wind layer.
    float pz = terr + z;
    vec2 toCam = u_camPos - pos;
    for (int i = 1; i <= 12; i++) {
      float t = float(i) / 13.0;
      t = t * t;
      if (terrainHeight(pos + toCam * t) > mix(pz, u_camAlt, t) + 30.0) {
        fade = 0.0;
        break;
      }
    }
  }

  // fade in on respawn so recycled drops don't pop
  float fadeIn = clamp(aux.x / 0.5, 0.0, 1.0);
  float endDim = (u_mode == 0 && end == 1) ? 0.15 : 1.0;
  v_alpha = aux.w * phaseW * fade * fadeIn * endDim;
  if (v_alpha < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // clip away
}`;

export const PRECIP_DRAW_FRAG = `#version 300 es
precision highp float;
precision highp int;

in float v_alpha;
in float v_frozen;
in float v_freezing;
out vec4 outColor;

uniform int u_mode;
uniform float u_opacity;
uniform vec3 u_ambientColor;  // lighting.js sunColor * ambient, premixed

void main() {
  vec3 rain = vec3(0.62, 0.76, 0.95);
  vec3 freezing = vec3(0.93, 0.55, 0.85);
  vec3 snow = vec3(0.96, 0.97, 1.0);
  float a = v_alpha * u_opacity;
  vec3 color;
  if (u_mode == 0) {
    color = mix(rain, freezing, step(0.5, v_freezing));
    a *= 0.68;
  } else {
    color = snow;
    // round soft flake
    float d = length(gl_PointCoord - 0.5);
    a *= smoothstep(0.5, 0.15, d) * 0.85;
  }
  color *= 0.45 + 0.55 * u_ambientColor;
  outColor = vec4(color, 1.0) * a;
}`;
