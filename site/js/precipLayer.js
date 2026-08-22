// MapLibre custom layer: falling precipitation. Rain draws as slanted streaks
// (GL_LINES), snow as soft points, both advected by the 10 m / 80 m wind and
// spawned beneath the local cloud base with density set by the precip rate.
//
// Structurally a slimmed WindLayer: ping-pong MRT float state, an offscreen
// update pass, then draw passes into MapLibre's framebuffer. Float state is
// required — on GPUs without EXT_color_buffer_float the layer stays dormant.
//
// Texture units (wind owns 0-7, FrameManager uploads on 12):
//   8 statePos, 9 stateAux, 10/11 weather atlas A/B, 13 hi-res terrain,
//   14/15 wind atlas A/B.

import { QUAD_VERT, PRECIP_UPDATE_FRAG, PRECIP_DRAW_VERT, PRECIP_DRAW_FRAG } from "./precipShaders.js";
import { compile, uniforms, makeBlankTex, computeSpawnBounds, cameraDomainPos } from "./glutil.js";

class PrecipState {
  constructor(gl, size) {
    this.gl = gl;
    this.size = size;
    this.state = [this.make(), this.make()];
    this.cur = 0;
    this.fbo = gl.createFramebuffer();
  }

  make() {
    const gl = this.gl;
    const n = this.size;
    const tex = (fill) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, n, 0, gl.RGBA, gl.FLOAT, fill);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return t;
    };
    const count = n * n;
    const pos = new Float32Array(count * 4);
    const aux = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      pos[i * 4] = Math.random();
      pos[i * 4 + 1] = Math.random();
      pos[i * 4 + 2] = Math.random() * 2500;
      // Stagger ages so the initial population doesn't recycle in lockstep;
      // alphaScale starts 0 so nothing shows until the update pass has
      // resettled particles onto actual rain.
      aux[i * 4] = Math.random() * 20;
      aux[i * 4 + 1] = Math.random();
      aux[i * 4 + 2] = Math.random() * 6.28318;
    }
    return { pos: tex(pos), aux: tex(aux) };
  }

  swap() { this.cur = 1 - this.cur; }
  get curState() { return this.state[this.cur]; }
  get prevState() { return this.state[1 - this.cur]; }

  destroy() {
    for (const s of this.state) {
      this.gl.deleteTexture(s.pos);
      this.gl.deleteTexture(s.aux);
    }
    this.gl.deleteFramebuffer(this.fbo);
  }
}

export class PrecipLayer {
  constructor(map, meta, windLayer, lighting, wxShared, opts = {}) {
    this.id = "precip-particles";
    this.type = "custom";
    this.renderingMode = "3d";
    this.map = map;
    this.meta = meta;
    this.windLayer = windLayer;  // shares its wind FrameManager + terrain tex
    this.lighting = lighting;
    this.wxShared = wxShared;    // { get(gl) -> FrameManager } for wNN.png
    this.enabled = opts.enabled ?? true;
    this.time = 0;
    this.opacity = 1.0;
    this.fallGain = opts.fallGain ?? 15;   // visual time compression
    this.particleCount = opts.particleCount ?? 65536;
    this.altScale = windLayer.altScale ?? 1;
    this.system = null;
    this.disabled = false; // set when float state is unavailable
    this._lastT = 0;

    window.addEventListener("windtime", (e) => { this.time = e.detail; });
  }

  onAdd(map, gl) {
    if (!(gl instanceof WebGL2RenderingContext) || !gl.getExtension("EXT_color_buffer_float")) {
      this.disabled = true;
      return;
    }
    this.gl = gl;
    this.updateProg = compile(gl, QUAD_VERT, PRECIP_UPDATE_FRAG);
    this.updateU = uniforms(gl, this.updateProg);
    this.drawProg = compile(gl, PRECIP_DRAW_VERT, PRECIP_DRAW_FRAG);
    this.drawU = uniforms(gl, this.drawProg);
    this.vao = gl.createVertexArray();
    this.blankTex = makeBlankTex(gl);
    this.wxFrames = this.wxShared.get(gl);
    this.rebuild();
  }

  onRemove() {
    this.system?.destroy();
    this.system = null;
  }

  setParticleCount(n) {
    this.particleCount = n;
    this.rebuild();
  }

  rebuild() {
    if (!this.gl || this.disabled) return;
    this.system?.destroy();
    const size = Math.max(16, 1 << Math.floor(Math.log2(Math.sqrt(this.particleCount))));
    this.system = new PrecipState(this.gl, size);
  }

  // Tile offset within an atlas grid, matching the pipeline layout.
  tileOff(index, cols, rows) {
    return [(index % cols) / cols, Math.floor(index / cols) / rows];
  }

  bindWx(gl, U) {
    const w = this.meta.weather;
    const { cols, rows } = w.atlas;
    gl.uniform2fv(U.u_wxTileScale, [1 / cols, 1 / rows]);
    gl.uniform2fv(U.u_wxClampMin, [0.5 / w.tile.width, 0.5 / w.tile.height]);
    gl.uniform2fv(U.u_wxClampMax, [1 - 0.5 / w.tile.width, 1 - 0.5 / w.tile.height]);
    gl.uniform2fv(U.u_precipOff, this.tileOff(w.tiles.precip, cols, rows));
    gl.uniform2fv(U.u_cloudOff, this.tileOff(w.tiles.cloud, cols, rows));
    gl.uniform1f(U.u_rateMax, w.enc.precipRate.max);
    gl.uniform1f(U.u_baseMax, w.enc.cloudBase.max);
  }

  bindWind(gl, U, pair) {
    const m = this.meta;
    const { cols, rows } = m.atlas;
    const l10 = m.levels.find((l) => l.id === "10m");
    const l80 = m.levels.find((l) => l.id === "80m") ?? l10;
    gl.uniform2fv(U.u_wTileScale, [1 / cols, 1 / rows]);
    gl.uniform2fv(U.u_wClampMin, [0.5 / m.tile.width, 0.5 / m.tile.height]);
    gl.uniform2fv(U.u_wClampMax, [1 - 0.5 / m.tile.width, 1 - 0.5 / m.tile.height]);
    gl.uniform2fv(U.u_w10Off, this.tileOff(l10.index, cols, rows));
    gl.uniform4fv(U.u_w10Scale, [l10.uMin, l10.uMax, l10.vMin, l10.vMax]);
    gl.uniform2fv(U.u_w80Off, this.tileOff(l80.index, cols, rows));
    gl.uniform4fv(U.u_w80Scale, [l80.uMin, l80.uMax, l80.vMin, l80.vMax]);
    gl.uniform1i(U.u_windA, 14);
    gl.uniform1i(U.u_windB, 15);
    gl.uniform1f(U.u_windMix, pair.mix);
    gl.activeTexture(gl.TEXTURE14);
    gl.bindTexture(gl.TEXTURE_2D, pair.texA);
    gl.activeTexture(gl.TEXTURE15);
    gl.bindTexture(gl.TEXTURE_2D, pair.texB);
    gl.activeTexture(gl.TEXTURE0);
  }

  bindTerrain(gl, U) {
    const hi = this.meta.terrainHi;
    const tex = this.windLayer.frames?.terrainTex;
    gl.uniform1f(U.u_hasTerrHi, tex ? 1.0 : 0.0);
    gl.uniform1i(U.u_terrHi, 13);
    if (tex && hi) gl.uniform2f(U.u_terrHiRange, hi.hMin, hi.hMax);
    gl.activeTexture(gl.TEXTURE13);
    gl.bindTexture(gl.TEXTURE_2D, tex ?? this.blankTex);
    gl.activeTexture(gl.TEXTURE0);
  }

  render(gl, matrix) {
    if (this.disabled || !this.system || !this.wxFrames) return;
    const sys = this.system;
    const wxPair = this.wxFrames.getPair(this.time);
    this.wxFrames.prefetch(this.time);
    const windPair = this.windLayer.frames?.getPair(this.time);
    if (!wxPair || !windPair) { this.map.triggerRepaint(); return; }
    if (!this.enabled) return;

    const b = this.meta.bounds;
    const lonSpan = b.east - b.west;
    const latSpan = b.north - b.south;
    const now = performance.now() / 1000;
    const dt = Math.min(this._lastT ? now - this._lastT : 0.016, 0.05);
    this._lastT = now;
    const spawn = computeSpawnBounds(this.map, b);

    // ---- update pass ----
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevVp = gl.getParameter(gl.VIEWPORT);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.useProgram(this.updateProg);
    gl.bindVertexArray(this.vao);
    const U = this.updateU;
    this.bindWx(gl, U);
    this.bindWind(gl, U, windPair);
    this.bindTerrain(gl, U);
    gl.uniform1i(U.u_statePos, 8);
    gl.uniform1i(U.u_stateAux, 9);
    gl.uniform1i(U.u_wxA, 10);
    gl.uniform1i(U.u_wxB, 11);
    gl.uniform1f(U.u_wxMix, wxPair.mix);
    gl.uniform1f(U.u_dt, dt);
    gl.uniform1f(U.u_fallGain, this.fallGain);
    gl.uniform1f(U.u_time, now % 1000);
    gl.uniform1f(U.u_north, b.north);
    gl.uniform1f(U.u_lonSpan, lonSpan);
    gl.uniform1f(U.u_latSpan, latSpan);
    gl.uniform2fv(U.u_spawnMin, spawn.min);
    gl.uniform2fv(U.u_spawnMax, spawn.max);
    gl.uniform1f(U.u_maxAge, 40.0);

    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, sys.curState.pos);
    gl.activeTexture(gl.TEXTURE9);
    gl.bindTexture(gl.TEXTURE_2D, sys.curState.aux);
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_2D, wxPair.texA);
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D, wxPair.texB);
    gl.activeTexture(gl.TEXTURE0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, sys.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sys.prevState.pos, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, sys.prevState.aux, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, sys.size, sys.size);
    // Re-issue right before the draw: MapLibre may run its own GL in between.
    gl.useProgram(this.updateProg);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    sys.swap();

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);

    // ---- draw passes ----
    const center = this.map.getCenter();
    const m2merc = maplibregl.MercatorCoordinate.fromLngLat(center, 1).z;
    let altScale = this.windLayer.altScale ?? 1;

    gl.useProgram(this.drawProg);
    const D = this.drawU;
    this.bindWx(gl, D);
    this.bindWind(gl, D, windPair);
    this.bindTerrain(gl, D);
    gl.uniformMatrix4fv(D.u_matrix, false, matrix);
    gl.uniform1i(D.u_statePos, 8);
    gl.uniform1i(D.u_stateAux, 9);
    gl.uniform1i(D.u_wxA, 10);
    gl.uniform1i(D.u_wxB, 11);
    gl.uniform1f(D.u_wxMix, wxPair.mix);
    gl.uniform1i(D.u_stateSize, sys.size);
    gl.uniform1f(D.u_west, b.west);
    gl.uniform1f(D.u_north, b.north);
    gl.uniform1f(D.u_lonSpan, lonSpan);
    gl.uniform1f(D.u_latSpan, latSpan);
    gl.uniform1f(D.u_altMerc, m2merc * altScale);
    gl.uniform1f(D.u_fallGain, this.fallGain);
    // One streak spans this much fall time: at 8 m/s x 15x gain, 1.2 s is a
    // ~145 m streak — long enough to read as rain from a city-scale zoom.
    gl.uniform1f(D.u_streakSec, 1.2);
    gl.uniform1f(D.u_time, now % 1000);
    gl.uniform1f(D.u_opacity, this.opacity);
    gl.uniform1f(D.u_pixelRatio, Math.min(window.devicePixelRatio || 1, 2));
    const light = this.lighting?.state;
    const amb = light ? light.sunColor.map((c) => c * (0.5 + 0.5 * light.ambient)) : [1, 1, 1];
    gl.uniform3fv(D.u_ambientColor, amb);

    const { camX, camY, camAlt } = cameraDomainPos(this.map, b);
    gl.uniform2f(D.u_camPos, camX, camY);
    gl.uniform1f(D.u_camAlt, camAlt);
    gl.uniform1f(D.u_occlude, camAlt > 0 ? 1.0 : 0.0);
    // Same near-field fade philosophy as the wind layer, sized from the box.
    const halfBoxKm = 0.5 * Math.max(
      (spawn.max[0] - spawn.min[0]) * lonSpan * 111.32 * Math.cos((center.lat * Math.PI) / 180),
      (spawn.max[1] - spawn.min[1]) * latSpan * 110.54,
    );
    const cutoff = Math.max(halfBoxKm * 2, 2);
    gl.uniform1f(D.u_fadeNear, cutoff * 0.6);
    gl.uniform1f(D.u_fadeFar, cutoff * 1.05);

    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, sys.curState.pos);
    gl.activeTexture(gl.TEXTURE9);
    gl.bindTexture(gl.TEXTURE_2D, sys.curState.aux);
    gl.activeTexture(gl.TEXTURE0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    // rain streaks
    gl.uniform1i(D.u_mode, 0);
    gl.useProgram(this.drawProg);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.LINES, 0, sys.size * sys.size * 2);
    // snow points
    gl.uniform1i(D.u_mode, 1);
    gl.drawArrays(gl.POINTS, 0, sys.size * sys.size);

    gl.bindVertexArray(null);
    this.map.triggerRepaint();
  }
}
