// MapLibre custom layer: GPU wind particles with a continuous vertical
// coordinate — one system spans the whole level stack and particles rise and
// sink with the model's vertical velocity (see shaders.js).

import { QUAD_VERT, UPDATE_FRAG, DRAW_VERT, DRAW_FRAG, MAX_STACK } from "./shaders.js";
import { rampTextureData, volumetricIndices, ladderSourceIndices, AGL_LADDER } from "./atmosphere.js";
import { FrameManager } from "./frames.js";
import { compile, uniforms, makeBlankTex, computeSpawnBounds, cameraDomainPos } from "./glutil.js";

const MAX_AGE = 90; // frames (float-state mode only)

class ParticleSystem {
  constructor(gl, levels, size, useFloat) {
    this.levels = levels; // meta level entries, surface -> top
    this.size = size;
    this.gl = gl;
    this.useFloat = useFloat;
    // ping-pong pairs of MRT state: [ {pos, aux}, {pos, aux} ]
    this.state = [this.makeState(), this.makeState()];
    this.cur = 0;
    this.fbo = gl.createFramebuffer();
  }

  makeState() {
    const gl = this.gl;
    const n = this.size;
    const make = (fill) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (this.useFloat) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, n, 0, gl.RGBA, gl.FLOAT, fill.f32);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, fill.u8);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return tex;
    };

    const count = n * n;
    const posF = new Float32Array(count * 4);
    const posB = new Uint8Array(count * 4);
    const auxF = new Float32Array(count * 4);
    const auxB = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      const x = Math.random(), y = Math.random(), sigma = Math.random();
      posF[i * 4] = x; posF[i * 4 + 1] = y;
      posB[i * 4] = Math.floor((x * 255 % 1) * 256);
      posB[i * 4 + 1] = Math.floor((y * 255 % 1) * 256);
      posB[i * 4 + 2] = Math.floor(x * 255);
      posB[i * 4 + 3] = Math.floor(y * 255);
      auxF[i * 4] = sigma; auxF[i * 4 + 1] = (Math.random() * MAX_AGE) / 255;
      auxB[i * 4] = Math.floor(sigma * 255);
    }
    return {
      pos: make({ f32: posF, u8: posB }),
      aux: make({ f32: auxF, u8: auxB }),
    };
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

export class WindLayer {
  constructor(map, meta, opts = {}) {
    this.id = "wind-particles";
    this.type = "custom";
    this.renderingMode = "3d";
    this.map = map;
    this.meta = meta;
    this.time = 0;              // forecast hour, continuous
    this.speedFactor = 1.0;
    // Multiplies the actual wind vector, not just the animation rate, so the
    // terrain physics responds as it would on a genuinely windier day. 1 = the
    // real forecast; anything above is clearly labelled as simulated.
    this.windGain = 1.0;
    this.exaggeration = opts.exaggeration ?? 1;
    // Height-above-terrain exaggeration. Defaults to the terrain's own
    // exaggeration so altitude is drawn at the same scale as the mountains —
    // any larger and particles float above the peaks they should be hitting
    // (at 2x, a particle 3 km up was drawn 1.5 km too high).
    this.altScale = opts.altScale ?? this.exaggeration;
    this.opacity = 1.0;
    // Let terrain occlude particles behind it. Only meaningful when the map
    // has 3D terrain (which writes depth); harmless otherwise.
    this.depthOcclusion = opts.depthOcclusion ?? true;
    this.volumetric = opts.volumetric ?? true;
    // Fly the particles at fixed heights above ground rather than on model
    // surfaces, so "the 10 m wind" is 10 m off the deck everywhere.
    this.useAglLadder = opts.useAglLadder ?? true;
    // Paint the wind onto the ground rather than as a layer above it. The
    // stack still samples true heights above ground — only the drawn height is
    // flattened — so the 10 m wind sits at the surface and no camera angle can
    // slip underneath the field.
    this.groundHug = opts.groundHug ?? true;
    this.aglLadder = opts.aglLadder ?? AGL_LADDER;
    this.levelIndices = this.volumetric
      ? (this.useAglLadder ? ladderSourceIndices(meta) : volumetricIndices(meta))
      : [meta.levels.findIndex((l) => l.id === "10m")];
    this.particleCount = 262144;
    this.system = null;
    this.frames = null;
    this.onReady = opts.onReady;

    // Terrain-driven flow physics (see TERRAIN_PHYSICS in shaders.js).
    this.terrainPhysics = opts.terrainPhysics ?? true;
    this.tuning = {
      // Master gain. Below 1 because HRRR already resolves some terrain
      // response at 3 km — this adds only what the 12 km regrid smoothed away.
      gain: 0.7,
      oroDecayH: 800,   // terrain influence e-folds out over ~800 m AGL
      gammaS: 0.5,      // slope and curvature weights sum to 1 so the
      gammaC: 0.5,      // speed factor stays within [0.5, 1.5]
      // Slope normalization is calibrated so the 90th-percentile slope over
      // mountainous terrain reaches the +/-0.5 ends of the MicroMet range.
      // It depends on the grid: the 12.8 km atlas tile flattens terrain far
      // more than the 1.4 km real-DEM texture (Montana p90 slope 0.033 vs
      // 0.161), so the two need very different scalings.
      slopeScale: 15.0,
      slopeScaleHi: 3.1,
      curvScale: 35.0,     // atlas-tile fallback only; hi-res ships normalized
      curvLength: 12800.0,
      ryanGain: 1.0,
      // Lee sheltering costs 8 extra terrain samples per particle; it is the
      // only term that produces wake shadows, so it stays on by default and
      // drops out on the low-memory path with everything else.
      mixRate: 0.02,
      leeGain: 0.6,
      leeDistM: 10000.0,
    };
  }

  onAdd(map, gl) {
    if (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) {
      throw new Error("WebGL2 required");
    }
    this.useFloat = !!gl.getExtension("EXT_color_buffer_float")
      && !new URLSearchParams(location.search).has("bytestate");
    const defines = this.useFloat ? "#define FLOAT_STATE" : "";
    this.gl = gl;
    this.updateProg = compile(gl, QUAD_VERT, UPDATE_FRAG, defines);
    this.updateU = uniforms(gl, this.updateProg);
    this.drawProg = compile(gl, DRAW_VERT, DRAW_FRAG, defines);
    this.drawU = uniforms(gl, this.drawProg);
    this.vao = gl.createVertexArray();

    // Stand-in for samplers whose real texture has not loaded yet.
    this.blankTex = makeBlankTex(gl);

    this.rampTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.rampTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rampTextureData());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.frames = new FrameManager(gl, this.meta);
    this.frames.loadTerrain(() => this.map.triggerRepaint());
    this.loadTerrainPixels();
    this.rebuildSystem();
    this.onReady?.(this);
  }

  onRemove() {
    this.system?.destroy();
    this.system = null;
  }

  setLevels(indices) {
    this.levelIndices = indices.slice(0, MAX_STACK);
    this.rebuildSystem();
  }

  setParticleCount(n) {
    this.particleCount = n;
    this.rebuildSystem();
  }

  rebuildSystem() {
    if (!this.gl) return;
    this.system?.destroy();
    const size = Math.max(16, 1 << Math.floor(Math.log2(Math.sqrt(this.particleCount))));
    const levels = this.levelIndices
      .map((i) => this.meta.levels[i])
      .sort((a, b) => a.heightMeters - b.heightMeters);
    this.system = new ParticleSystem(this.gl, levels, size, this.useFloat);
    this.stackUniforms = this.buildStackUniforms(levels);
  }

  buildStackUniforms(levels) {
    const { cols, rows } = this.meta.atlas;
    const L = levels.length;
    const tileOff = new Float32Array(MAX_STACK * 2);
    const uvScale = new Float32Array(MAX_STACK * 4);
    const wScale = new Float32Array(MAX_STACK * 2);
    const wFactor = new Float32Array(MAX_STACK);
    const height = new Float32Array(MAX_STACK);
    const isAgl = new Float32Array(MAX_STACK);
    for (let k = 0; k < MAX_STACK; k++) {
      const lv = levels[Math.min(k, L - 1)];
      tileOff[k * 2] = (lv.index % cols) / cols;
      tileOff[k * 2 + 1] = Math.floor(lv.index / cols) / rows;
      uvScale.set([lv.uMin, lv.uMax, lv.vMin, lv.vMax], k * 4);
      wScale.set([lv.wMin ?? -1, lv.wMax ?? 1], k * 2);
      wFactor[k] = lv.wFactor ?? 0;
      height[k] = lv.heightMeters;
      isAgl[k] = lv.kind === "height_agl" ? 1 : 0;
    }
    // Pressure levels forced below ground stack above the highest true
    // above-ground level rather than from an arbitrary zero.
    const aglTop = levels.reduce(
      (m, lv) => (lv.kind === "height_agl" ? Math.max(m, lv.heightMeters) : m), 0
    ) + 40;

    const ladder = new Float32Array(MAX_STACK);
    const rungs = this.aglLadder.slice(0, MAX_STACK);
    for (let k = 0; k < MAX_STACK; k++) ladder[k] = rungs[Math.min(k, rungs.length - 1)];
    const hx = 0.5 / (this.meta.tile.width * cols) * cols;
    const hy = 0.5 / (this.meta.tile.height * rows) * rows;
    const t = this.meta.terrain;
    return {
      len: L, tileOff, uvScale, wScale, wFactor, height, isAgl, aglTop,
      ladder, ladderLen: rungs.length,
      tileScale: [1 / cols, 1 / rows],
      clampMin: [hx, hy],
      clampMax: [1 - hx, 1 - hy],
      terrOff: t ? [(t.index % cols) / cols, Math.floor(t.index / cols) / rows] : [0, 0],
      terrRange: t ? [t.hMin, t.hMax] : [0, 0],
    };
  }

  // Both passes must resolve terrain identically or particles would be drawn
  // at a different height than they were advected at.
  setTerrainUniforms(gl, U, unit) {
    const hi = this.meta.terrainHi;
    const tex = this.frames?.terrainTex;
    gl.uniform1f(U.u_hasTerrHi, tex ? 1.0 : 0.0);
    if (!tex) {
      // A declared sampler must still point at a complete texture even on the
      // branch that never reads it, or the draw is INVALID_OPERATION. This
      // fires on the frames before the terrain PNG finishes uploading.
      gl.uniform1i(U.u_terrHi, unit);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.blankTex);
      gl.activeTexture(gl.TEXTURE0);
      return;
    }
    gl.uniform2f(U.u_terrHiRange, hi.hMin, hi.hMax);
    gl.uniform1i(U.u_terrHi, unit);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.activeTexture(gl.TEXTURE0); // leave the active unit where callers expect it
  }

  // CPU copy of the shader's terrainHeight(), so the on-screen readout shows
  // exactly the value the shader is using rather than an approximation.
  sampleTerrain(nx, ny) {
    const hi = this.meta.terrainHi;
    if (!hi || !this._terrPixels) return null;
    const x = Math.round(Math.max(0, Math.min(1, nx)) * (hi.width - 1));
    const y = Math.round(Math.max(0, Math.min(1, ny)) * (hi.height - 1));
    const i = (y * hi.width + x) * 4;
    const d = this._terrPixels;
    const t = (d[i] * 256 + d[i + 1]) / 65535;
    return hi.hMin + t * (hi.hMax - hi.hMin);
  }

  // Decode the terrain PNG once into a CPU array for sampleTerrain.
  loadTerrainPixels() {
    const hi = this.meta.terrainHi;
    if (!hi?.file) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = hi.width; cv.height = hi.height;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        this._terrPixels = ctx.getImageData(0, 0, hi.width, hi.height).data;
      } catch { /* readout unavailable; rendering is unaffected */ }
    };
    img.src = `data/${hi.file}`;
  }

  setStackUniforms(gl, U) {
    const s = this.stackUniforms;
    gl.uniform1i(U.u_stackLen, s.len);
    gl.uniform2fv(U.u_tileOff, s.tileOff);
    gl.uniform4fv(U.u_uvScale, s.uvScale);
    gl.uniform2fv(U.u_wScale, s.wScale);
    gl.uniform1fv(U.u_wFactor, s.wFactor);
    gl.uniform1fv(U.u_height, s.height);
    gl.uniform1fv(U.u_isAgl, s.isAgl);
    gl.uniform1f(U.u_aglTop, s.aglTop);
    gl.uniform1fv(U.u_aglLadder, s.ladder);
    gl.uniform1i(U.u_ladderLen, s.ladderLen);
    gl.uniform1f(U.u_useLadder, this.useAglLadder ? 1.0 : 0.0);
    gl.uniform2fv(U.u_tileScale, s.tileScale);
    gl.uniform2fv(U.u_clampMin, s.clampMin);
    gl.uniform2fv(U.u_clampMax, s.clampMax);
    gl.uniform2fv(U.u_terrOff, s.terrOff);
    gl.uniform2fv(U.u_terrRange, s.terrRange);
  }

  // Respawn region follows the viewport (padded), so zoomed-in views stay
  // densely seeded instead of spreading 65k particles across all of CONUS.
  // Shared with the precip/cloud layers via glutil.
  spawnBounds() {
    return computeSpawnBounds(this.map, this.meta.bounds);
  }

  render(gl, matrix) {
    const sys = this.system;
    if (!sys || !this.frames) return;
    const pair = this.frames.getPair(this.time);
    this.frames.prefetch(this.time);
    if (!pair) { this.map.triggerRepaint(); return; }

    const b = this.meta.bounds;
    const lonSpan = b.east - b.west;
    const latSpan = b.north - b.south;

    // ---- update pass (offscreen, MRT) ----
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevVp = gl.getParameter(gl.VIEWPORT);

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.updateProg);
    const U = this.updateU;
    this.setStackUniforms(gl, U);
    gl.uniform1i(U.u_statePos, 0);
    gl.uniform1i(U.u_stateAux, 1);
    gl.uniform1i(U.u_frameA, 2);
    gl.uniform1i(U.u_frameB, 3);
    gl.uniform1f(U.u_frameMix, pair.mix);
    gl.uniform1f(U.u_north, b.north);
    gl.uniform1f(U.u_lonSpan, lonSpan);
    gl.uniform1f(U.u_latSpan, latSpan);
    // simulated seconds per frame, scaled down when zoomed in so motion stays
    // smooth (constant-ish screen-space speed)
    const zoomFactor = Math.min(1, Math.pow(1.6, 4 - this.map.getZoom()));
    const dtSeconds = 90.0 * this.speedFactor * Math.max(zoomFactor, 0.03);
    gl.uniform1f(U.u_dt, dtSeconds);
    gl.uniform1f(U.u_windGain, this.windGain);
    gl.uniform1f(U.u_maxAge, MAX_AGE);
    gl.uniform1f(U.u_time, (performance.now() % 100000) / 1000);
    const spawn = this.spawnBounds();
    gl.uniform2fv(U.u_spawnMin, spawn.min);
    gl.uniform2fv(U.u_spawnMax, spawn.max);

    // Ground point a little way in front of the camera, and how hard to pull
    // respawns toward it. The steeper the pitch the more the far field
    // dominates the frame, so the stronger the pull needs to be.
    let camUp = [(spawn.min[0] + spawn.max[0]) / 2, (spawn.min[1] + spawn.max[1]) / 2];
    let bias = 0;
    try {
      const cw = this.map.getCanvas().clientWidth;
      const ch = this.map.getCanvas().clientHeight;
      const fg = this.map.unproject([cw / 2, ch * 0.88]);
      camUp = [(fg.lng - b.west) / lonSpan, (b.north - fg.lat) / latSpan];
      bias = Math.min(0.97, Math.max(0, (this.map.getPitch() - 25) / 60));
    } catch { bias = 0; }
    gl.uniform2fv(U.u_camPosUp, camUp);
    gl.uniform1f(U.u_spawnBias, bias);

    const tp = this.tuning;
    const hiRes = !!this.frames?.terrainTex;
    const tSrc = hiRes ? this.meta.terrainHi : this.meta.tile;
    gl.uniform1f(U.u_tp, this.terrainPhysics ? tp.gain : 0.0);
    // Vertical mixing rate (1/s). Terrain-following and orographic lift are
    // both one-way over a ridge; without this, parcels pin at the top of the
    // stack or scrape the ground and never recover.
    gl.uniform1f(U.u_mixRate, tp.mixRate);
    gl.uniform2f(U.u_terrTexel, 1 / tSrc.width, 1 / tSrc.height);
    gl.uniform1f(U.u_oroDecayH, tp.oroDecayH);
    gl.uniform1f(U.u_gammaS, tp.gammaS);
    gl.uniform1f(U.u_gammaC, tp.gammaC);
    // Finer terrain resolves steeper slopes, so the normalization that maps
    // slope onto the MicroMet range differs per grid.
    gl.uniform1f(U.u_slopeScale, hiRes ? tp.slopeScaleHi : tp.slopeScale);
    gl.uniform1f(U.u_curvScale, tp.curvScale);
    gl.uniform1f(U.u_curvLength, tp.curvLength);
    gl.uniform1f(U.u_ryanGain, tp.ryanGain);
    gl.uniform1f(U.u_leeGain, tp.leeGain);
    gl.uniform1f(U.u_leeDistM, tp.leeDistM);
    // A fast particle covers ~2.7 km per 90 s step, more than one hi-res
    // terrain cell, so without substeps it can hop a ridge without ever
    // sampling it. Only worth paying for when the physics is actually on.
    const cellKm = hiRes ? 2.1 : 12.7;
    const stepKm = (35.0 * dtSeconds) / 1000.0; // a fast jet, not the mean
    gl.uniform1i(U.u_substeps, this.terrainPhysics
      ? Math.max(1, Math.min(4, Math.ceil(stepKm / cellKm)))
      : 1);
    this.setTerrainUniforms(gl, U, 7);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sys.curState.pos);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, sys.curState.aux);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, pair.texA);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, pair.texB);

    gl.bindFramebuffer(gl.FRAMEBUFFER, sys.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sys.prevState.pos, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, sys.prevState.aux, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, sys.size, sys.size);
    // Re-bind immediately before drawing: with 3D terrain enabled MapLibre can
    // run its own GL work between our useProgram above and this call, leaving a
    // different program current and making the draw INVALID_OPERATION.
    gl.useProgram(this.updateProg);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    sys.swap();

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);

    // ---- draw pass ----
    const center = this.map.getCenter();
    const m2merc = maplibregl.MercatorCoordinate.fromLngLat(center, 1).z;

    gl.useProgram(this.drawProg);
    const D = this.drawU;
    this.setStackUniforms(gl, D);
    gl.uniformMatrix4fv(D.u_matrix, false, matrix);
    gl.uniform1i(D.u_statePosCurr, 0);
    gl.uniform1i(D.u_statePosPrev, 1);
    gl.uniform1i(D.u_stateAuxCurr, 2);
    gl.uniform1i(D.u_ramp, 4);
    gl.uniform1i(D.u_frameA, 5);
    gl.uniform1i(D.u_frameB, 6);
    gl.uniform1f(D.u_frameMix, pair.mix);
    gl.uniform1f(D.u_west, b.west);
    gl.uniform1f(D.u_north, b.north);
    gl.uniform1f(D.u_lonSpan, lonSpan);
    gl.uniform1f(D.u_latSpan, latSpan);
    gl.uniform1f(D.u_altMerc, m2merc * this.altScale);
    // Read the map's ACTUAL terrain exaggeration rather than our own copy of
    // it. They drift apart — the layer is constructed with 1.5 while the map
    // may be rendering at another value — and any mismatch scales our terrain
    // base differently from the rendered mountains, so the whole field floats
    // above or sinks below the ground it is supposed to sit on.
    let mapExag = this.exaggeration;
    try {
      const t = this.map.getTerrain();
      if (t && typeof t.exaggeration === "number") mapExag = t.exaggeration;
      else if (!t) mapExag = 0;   // terrain off: the map draws flat ground
    } catch { /* keep our own value */ }
    gl.uniform1f(D.u_exagMerc, m2merc * mapExag);
    // Metres of ground per screen pixel — the scale everything visual has to
    // be measured against.
    const mppNow = 156543.03392 * Math.cos((center.lat * Math.PI) / 180)
      / Math.pow(2, this.map.getZoom());
    // Streak length is in units of the last frame's movement, so it already
    // scales with wind speed and dt — growing it with zoom on top of that
    // turns the close-in field into long rakes. But dt SATURATES at 90 s
    // while metres-per-pixel keeps doubling as you zoom out, so past about
    // zoom 6 a streak falls under one pixel and the flow disappears from a
    // regional view. Boost only once the ground scale passes the close-in
    // reference, which leaves the near view exactly as it was and keeps the
    // wind readable as short dashes all the way out to the full domain.
    const streakBoost = Math.min(10, Math.max(1, mppNow / 200));
    gl.uniform1f(D.u_streak, 4.0 * streakBoost);
    gl.uniform1f(D.u_maxAge, MAX_AGE);
    // Longer strokes lay down proportionally more ink, and the particle count
    // does not drop when you zoom out (the spawn box always fills the view),
    // so a continental view saturated into a solid blue carpet that buried
    // the terrain and the clouds. Thin the strokes as they lengthen to hold
    // the total ink roughly constant, and the flow stays a field of dashes.
    const inkFade = Math.max(0.5, 1 / (1 + 0.5 * (streakBoost - 1)));
    gl.uniform1f(D.u_opacity, this.opacity * inkFade);
    gl.uniform1f(D.u_windGain, this.windGain);
    // Height of the lowest rung, subtracted so the column starts on the ground.
    gl.uniform1f(D.u_ladderBase, this.groundHug ? (this.aglLadder[0] ?? 0) : 0);
    gl.uniform1f(D.u_yOffset, this.yOffset ?? 0);
    // Surface mode draws the whole field as a skin on the terrain; the
    // vertical spread only reappears with the 3D column.
    gl.uniform1f(D.u_groundLock, this.groundHug ? 1.0 : 0.0);
    // Clearance over the terrain mesh, in metres of ground. Tied to the size
    // of a screen pixel (mppNow above) so it stays a fraction of a pixel at
    // any zoom: enough to avoid z-fighting and not be swallowed by the
    // hillside, small enough that the wind still reads as painted on the
    // surface. Anything larger becomes a visible gap under the wind.
    gl.uniform1f(D.u_surfaceLift, Math.min(4, Math.max(0.5, mppNow * 0.5)));
    gl.uniform1i(D.u_stateSize, sys.size);
    this.setTerrainUniforms(gl, D, 7);

    // Camera ground position + altitude, for the terrain occlusion raymarch.
    // getFreeCameraOptions is not in every MapLibre build, so derive it from
    // the transform: the eye sits behind the map centre along the bearing, at
    // a distance set by pitch and the metres-per-pixel scale.
    // (Asking the transform for the real eye point: deriving it from pitch and
    // zoom was off by more than 2x, which put the camera below the ridgeline
    // it was plainly looking over and made every line-of-sight test wrong.)
    const { camX, camY, camAlt } = cameraDomainPos(this.map, b);
    gl.uniform2f(D.u_camPos, camX, camY);
    gl.uniform1f(D.u_camAlt, camAlt);
    gl.uniform1f(D.u_occlude, this.depthOcclusion && camAlt > 0 ? 1.0 : 0.0);

    // Live readouts for dialling in the trim: what the shader thinks the
    // ground is under the middle of the screen, versus what MapLibre draws
    // there. The gap between them is the offset we are looking for.
    if (this.onProbe) {
      try {
        const cw = this.map.getCanvas().clientWidth;
        const ch = this.map.getCanvas().clientHeight;
        const ll = this.map.unproject([cw / 2, ch * 0.75]);
        this.onProbe({
          shaderTerrain: this.sampleTerrain(
            (ll.lng - b.west) / lonSpan, (b.north - ll.lat) / latSpan),
          mapTerrain: this.map.queryTerrainElevation
            ? this.map.queryTerrainElevation(ll) : null,
          cameraAlt: camAlt,
          yOffset: this.yOffset ?? 0,
        });
      } catch { /* readouts are best-effort */ }
    }
    // Fade out roughly beyond the near half of the view, so the frame is about
    // the terrain in front of you rather than the horizon. Measure how far the
    // camera actually sees UP the screen, not the east-west span: on a tall
    // phone viewport the latter is small while the ground reaches much
    // further, and using it faded the whole foreground away.
    let viewKm = 40;
    try {
      const cw = this.map.getCanvas().clientWidth;
      const ch = this.map.getCanvas().clientHeight;
      const nearPt = this.map.unproject([cw / 2, ch]);
      const midPt = this.map.unproject([cw / 2, ch * 0.35]);
      const dLatKm = Math.abs(midPt.lat - nearPt.lat) * 110.54;
      const dLonKm = Math.abs(midPt.lng - nearPt.lng) * 111.32
        * Math.cos((center.lat * Math.PI) / 180);
      viewKm = Math.max(Math.hypot(dLatKm, dLonKm), 8);
    } catch { /* keep the default */ }
    // Cut off well inside the horizon. Ground far away compresses into a few
    // rows of pixels near the skyline, so even correctly-placed surface wind
    // piles up there as a solid mat — a ceiling over the mountains when you
    // look up from a valley. Fading out over the near field keeps the frame
    // about the terrain you are actually looking at.
    // The window has to close INSIDE the spawn box or nothing is ever fully
    // faded — at a steep pitch the box only reaches ~60 km and the old
    // 0.6-1.3x window ended exactly there, so every distant particle survived
    // and piled up along the skyline.
    // Fade out INSIDE the spawn box, not past it. The box is a hard boundary —
    // particles simply stop existing at its edge — so if the fade finishes
    // beyond it the field ends in a visible arc across the ground. Fading over
    // the outer part of the box hides the seam.
    const halfBoxKm = 0.5 * Math.max(
      (spawn.max[0] - spawn.min[0]) * lonSpan * 111.32
        * Math.cos((center.lat * Math.PI) / 180),
      (spawn.max[1] - spawn.min[1]) * latSpan * 110.54,
    );
    // Distances here are measured from the CAMERA, while the box is centred on
    // what the camera is looking at — so the far edge of the box sits at
    // roughly (look-at distance + half the box). Cutting at half the box alone
    // erased the whole field.
    const cutoff = Math.max(viewKm + halfBoxKm, 2);
    gl.uniform1f(D.u_fadeNear, cutoff * 0.6);
    gl.uniform1f(D.u_fadeFar, cutoff * 1.05);

    gl.enable(gl.BLEND);
    // premultiplied over-blending: readable on bright satellite imagery
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // MapLibre's terrain depth is not in this framebuffer, so the GPU depth
    // test cannot hide air behind a ridge — the draw shader raymarches the
    // terrain texture instead (see u_occlude).
    gl.disable(gl.DEPTH_TEST);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sys.curState.pos);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, sys.prevState.pos);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, sys.curState.aux);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTex);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, pair.texA);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, pair.texB);

    gl.useProgram(this.drawProg);   // same reason as the update pass above
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.LINES, 0, sys.size * sys.size * 2);

    gl.bindVertexArray(null);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.map.triggerRepaint();
  }
}
