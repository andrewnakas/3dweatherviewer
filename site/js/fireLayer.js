// MapLibre custom layer: NASA FIRMS active-fire hotspots.
//
// The pipeline snapshots FIRMS VIIRS detections into data/fires.json at build
// time (no API key in the browser, no cross-origin fetch). Each merged fire
// becomes one additive glowing quad on the terrain, sized by fire radiative
// power. Fires are a fixed set per build, so they live in a small float data
// texture and are indexed by gl_VertexID — no vertex buffers, matching the
// other layers.
//
// Texture units: 10 fire data, 13 hi-res terrain.

import { FIRE_VERT, FIRE_FRAG } from "./fireShaders.js";
import { compile, uniforms, makeBlankTex, cameraDomainPos } from "./glutil.js";

const TEX_W = 256; // fires are laid out row-major in a 256-wide float texture

export class FireLayer {
  constructor(map, meta, windLayer, opts = {}) {
    this.id = "fire-hotspots";
    this.type = "custom";
    this.renderingMode = "3d";
    this.map = map;
    this.meta = meta;
    this.windLayer = windLayer;   // shared terrain texture + altitude scale
    this.enabled = opts.enabled ?? true;
    this.opacity = 1.0;
    this.scale = 1.0;
    this.fires = null;            // Float32Array once loaded
    this.count = 0;
  }

  // fires: [[lon, lat, frpMW, ageHours, confidence], ...] from fires.json
  setFires(list) {
    const b = this.meta.bounds;
    const lonSpan = b.east - b.west;
    const latSpan = b.north - b.south;
    const n = list.length;
    const rows = Math.max(1, Math.ceil(n / TEX_W));
    const data = new Float32Array(TEX_W * rows * 4);
    for (let i = 0; i < n; i++) {
      const [lon, lat, frp, ageH] = list[i];
      data[i * 4] = (lon - b.west) / lonSpan;
      data[i * 4 + 1] = (b.north - lat) / latSpan;
      data[i * 4 + 2] = frp;
      data[i * 4 + 3] = ageH ?? 0;
    }
    this.fires = data;
    this.count = n;
    this.rows = rows;
    if (this.gl) this.uploadFires();
    this.map.triggerRepaint();
  }

  uploadFires() {
    const gl = this.gl;
    if (!this.fires) return;
    this.fireTex ??= gl.createTexture();
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_2D, this.fireTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, this.rows, 0,
      gl.RGBA, gl.FLOAT, this.fires);
    // NEAREST only: these are records, not an image — never interpolate
    // between two different fires.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
  }

  onAdd(map, gl) {
    if (!(gl instanceof WebGL2RenderingContext)) throw new Error("WebGL2 required");
    this.gl = gl;
    this.prog = compile(gl, FIRE_VERT, FIRE_FRAG);
    this.U = uniforms(gl, this.prog);
    this.vao = gl.createVertexArray();
    this.blankTex = makeBlankTex(gl);
    if (this.fires) this.uploadFires();
  }

  onRemove() {
    if (this.gl && this.fireTex) this.gl.deleteTexture(this.fireTex);
    this.fireTex = null;
  }

  render(gl, matrix) {
    if (!this.enabled || !this.count || !this.fireTex) return;

    const b = this.meta.bounds;
    const center = this.map.getCenter();
    const m2merc = maplibregl.MercatorCoordinate.fromLngLat(center, 1).z;
    const mpp = 156543.03392 * Math.cos((center.lat * Math.PI) / 180)
      / Math.pow(2, this.map.getZoom());

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const U = this.U;
    gl.uniformMatrix4fv(U.u_matrix, false, matrix);
    gl.uniform1f(U.u_west, b.west);
    gl.uniform1f(U.u_north, b.north);
    gl.uniform1f(U.u_lonSpan, b.east - b.west);
    gl.uniform1f(U.u_latSpan, b.north - b.south);
    gl.uniform1f(U.u_altMerc, m2merc * (this.windLayer.altScale ?? 1));
    gl.uniform1f(U.u_m2merc, m2merc);
    gl.uniform1f(U.u_mpp, mpp);
    gl.uniform1f(U.u_time, (performance.now() / 1000) % 1000);
    gl.uniform1f(U.u_opacity, this.opacity);
    gl.uniform1f(U.u_scale, this.scale);
    gl.uniform1i(U.u_fireCount, this.count);
    gl.uniform1i(U.u_texWidth, TEX_W);

    const br = (this.map.getBearing() * Math.PI) / 180;
    const pt = (this.map.getPitch() * Math.PI) / 180;
    gl.uniform3fv(U.u_camRight, [Math.cos(br), -Math.sin(br), 0]);
    gl.uniform3fv(U.u_camUp, [Math.sin(br) * Math.cos(pt), Math.cos(br) * Math.cos(pt), Math.sin(pt)]);

    const { camX, camY, camAlt } = cameraDomainPos(this.map, b);
    gl.uniform2f(U.u_camPos, camX, camY);
    gl.uniform1f(U.u_camAlt, camAlt);
    gl.uniform1f(U.u_occlude, camAlt > 0 ? 1.0 : 0.0);

    const terrTex = this.windLayer.frames?.terrainTex;
    const hi = this.meta.terrainHi;
    gl.uniform1f(U.u_hasTerrHi, terrTex ? 1.0 : 0.0);
    gl.uniform1i(U.u_terrHi, 13);
    if (terrTex && hi) gl.uniform2f(U.u_terrHiRange, hi.hMin, hi.hMax);

    gl.uniform1i(U.u_fires, 10);
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_2D, this.fireTex);
    gl.activeTexture(gl.TEXTURE13);
    gl.bindTexture(gl.TEXTURE_2D, terrTex ?? this.blankTex);
    gl.activeTexture(gl.TEXTURE0);

    gl.enable(gl.BLEND);
    // Additive: a fire emits light, so it brightens whatever is behind it
    // instead of masking it — which is also what keeps it legible at night.
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.disable(gl.DEPTH_TEST);

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.count * 6);

    gl.bindVertexArray(null);
    // restore the premultiplied-over blending every other layer expects
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.map.triggerRepaint();
  }
}
