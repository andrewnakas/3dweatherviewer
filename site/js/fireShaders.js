// GLSL for NASA FIRMS active-fire hotspots: one additive glowing quad per
// fire, sitting on the terrain, sized and colored by fire radiative power
// with a per-fire flicker. Fires come from a data texture (x, y, FRP, seed)
// indexed by gl_VertexID, so there are no vertex buffers here either.

import { TERRAIN_GLSL } from "./shaders.js";

export const FIRE_VERT = `#version 300 es
precision highp float;

uniform sampler2D u_fires;   // RGBA32F: x, y (domain), FRP (MW), age (hours)
uniform int u_fireCount;
uniform int u_texWidth;
uniform mat4 u_matrix;
uniform float u_west;
uniform float u_north;
uniform float u_lonSpan;
uniform float u_latSpan;
uniform float u_altMerc;
uniform float u_m2merc;
uniform float u_mpp;         // metres of ground per screen pixel
uniform float u_time;
uniform vec3 u_camRight;
uniform vec3 u_camUp;
uniform vec2 u_camPos;
uniform float u_camAlt;
uniform float u_occlude;
uniform float u_scale;       // user size control

out vec2 v_uv;
out float v_intensity;       // 0..1 from FRP
out float v_flicker;
out float v_fresh;           // 1 = detected in the last few hours

const float PI = 3.141592653589793;

${TERRAIN_GLSL}

float terrainHeight(vec2 pos) {
  return u_hasTerrHi > 0.5 ? terrainHeightHi(pos) : 0.0;
}

void collapse() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); v_intensity = 0.0; }

void main() {
  int pid = gl_VertexID / 6;
  int corner = gl_VertexID - pid * 6;
  if (pid >= u_fireCount) { collapse(); return; }
  vec2 c = corner == 0 ? vec2(-1, -1) : corner == 1 ? vec2(1, -1) : corner == 2 ? vec2(1, 1)
         : corner == 3 ? vec2(-1, -1) : corner == 4 ? vec2(1, 1) : vec2(-1, 1);
  v_uv = c;

  vec4 f = texelFetch(u_fires, ivec2(pid % u_texWidth, pid / u_texWidth), 0);
  vec2 pos = f.xy;
  float frp = f.z;
  float ageH = f.w;

  // FRP spans four orders of magnitude (1 MW smoulder to ~8 GW megafire), so
  // size on a log scale or every small fire disappears next to a big one.
  v_intensity = clamp(log(1.0 + frp) / log(1.0 + 2000.0), 0.0, 1.0);
  v_fresh = 1.0 - smoothstep(2.0, 20.0, ageH);
  float seed = fract(sin(float(pid) * 12.9898) * 43758.5453);
  v_flicker = 0.75 + 0.25 * sin(u_time * (5.0 + 4.0 * seed) + seed * 31.0);

  // Screen-anchored size: a hotspot must stay visible from continental zoom
  // (where its real footprint is far under a pixel) without swelling into a
  // blob up close, so the radius is clamped in PIXELS, not metres.
  float px = mix(4.0, 15.0, v_intensity) * u_scale;
  float radius = clamp(px * u_mpp, 120.0, 60000.0);

  float terr = terrainHeight(pos);
  float lon = u_west + pos.x * u_lonSpan;
  float latP = u_north - pos.y * u_latSpan;
  float mx = (lon + 180.0) / 360.0;
  float sm = clamp(sin(radians(latP)), -0.9999, 0.9999);
  float my = 0.5 - 0.25 * log((1.0 + sm) / (1.0 - sm)) / PI;

  vec3 off = (u_camRight * c.x + u_camUp * c.y) * radius;
  // a little above the deck so the glow is not swallowed by the terrain mesh
  float zAgl = 40.0 + radius * 0.15;
  vec3 world = vec3(mx + off.x * u_m2merc,
                    my - off.y * u_m2merc,
                    (zAgl + off.z) * u_altMerc);
  gl_Position = u_matrix * vec4(world, 1.0);

  if (u_occlude > 0.5) {
    float pz = terr + zAgl;
    vec2 toCam = u_camPos - pos;
    for (int i = 1; i <= 8; i++) {
      float t = float(i) / 9.0;
      t = t * t;
      if (terrainHeight(pos + toCam * t) > mix(pz, u_camAlt, t) + 80.0) {
        collapse();
        return;
      }
    }
  }
}`;

export const FIRE_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
in float v_intensity;
in float v_flicker;
in float v_fresh;
out vec4 outColor;

uniform float u_opacity;

void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;
  // white-hot core -> orange -> red halo
  float core = smoothstep(0.55, 0.0, d);
  float halo = smoothstep(1.0, 0.15, d);
  vec3 color = mix(vec3(0.95, 0.25, 0.06), vec3(1.0, 0.85, 0.55), core * core);
  float a = (halo * 0.38 + core * 0.62) * (0.45 + 0.55 * v_intensity)
          * v_flicker * mix(0.45, 1.0, v_fresh) * u_opacity;
  // additive: fires ADD light to the scene rather than covering it
  outColor = vec4(color * a, a);
}`;
