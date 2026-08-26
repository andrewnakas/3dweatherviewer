// MapLibre custom layer: lit billboard cloud puffs. Stateless — no update
// pass, no particle textures; every puff is re-derived in the vertex shader
// from gl_VertexID and the weather atlas, pinned to an absolute world lattice.
//
// Texture units: 8/9 weather atlas A/B, 13 hi-res terrain (shared convention
// with the precip layer; the two never render in the same draw call so the
// same units are safe).

import { CLOUD_VERT, CLOUD_FRAG, QC_LEVELS } from "./cloudShaders.js";
import { compile, uniforms, makeBlankTex, computeSpawnBounds, cameraDomainPos, tieredLattice } from "./glutil.js";

export class CloudLayer {
  constructor(map, meta, windLayer, lighting, wxShared, opts = {}) {
    this.id = "cloud-puffs";
    this.type = "custom";
    this.renderingMode = "3d";
    this.map = map;
    this.meta = meta;
    this.windLayer = windLayer;   // for the shared terrain texture + altScale
    this.lighting = lighting;
    this.wxShared = wxShared;     // { get(gl) -> FrameManager } for wNN.png
    this.enabled = opts.enabled ?? true;
    this.time = 0;
    this.opacity = 1.0;
    this.density = 1.0;
    this.grid = opts.grid ?? 72;      // G x G lattice cells
    this.layers = opts.layers ?? 3;   // vertical slots per cell
    window.addEventListener("windtime", (e) => { this.time = e.detail; });
  }

  onAdd(map, gl) {
    if (!(gl instanceof WebGL2RenderingContext)) throw new Error("WebGL2 required");
    this.gl = gl;
    this.prog = compile(gl, CLOUD_VERT, CLOUD_FRAG);
    this.U = uniforms(gl, this.prog);
    this.vao = gl.createVertexArray();
    this.blankTex = makeBlankTex(gl);
    this.wxFrames = this.wxShared.get(gl);

    const w = this.meta.weather;
    const { cols, rows } = w.atlas;
    this.qcOff = new Float32Array(QC_LEVELS * 2);
    this.qcHeight = new Float32Array(QC_LEVELS);
    const cond = w.condensate ?? [];
    this.qcLen = Math.min(cond.length, QC_LEVELS);
    for (let k = 0; k < QC_LEVELS; k++) {
      const c = cond[Math.min(k, this.qcLen - 1)];
      this.qcOff[k * 2] = (c.index % cols) / cols;
      this.qcOff[k * 2 + 1] = Math.floor(c.index / cols) / rows;
      this.qcHeight[k] = c.heightMeters;
    }
  }

  onRemove() { /* nothing owned beyond GL objects the context reclaims */ }

  render(gl, matrix) {
    if (!this.wxFrames) return;
    const pair = this.wxFrames.getPair(this.time);
    this.wxFrames.prefetch(this.time);
    if (!pair) { this.map.triggerRepaint(); return; }
    if (!this.enabled) return;

    const b = this.meta.bounds;
    const lonSpan = b.east - b.west;
    const latSpan = b.north - b.south;
    const w = this.meta.weather;
    const spawn = computeSpawnBounds(this.map, b);
    const center = this.map.getCenter();
    const m2merc = maplibregl.MercatorCoordinate.fromLngLat(center, 1).z;
    const altScale = this.windLayer.altScale ?? 1;

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const U = this.U;
    gl.uniformMatrix4fv(U.u_matrix, false, matrix);
    gl.uniform1f(U.u_west, b.west);
    gl.uniform1f(U.u_north, b.north);
    gl.uniform1f(U.u_lonSpan, lonSpan);
    gl.uniform1f(U.u_latSpan, latSpan);
    gl.uniform1f(U.u_altMerc, m2merc * altScale);
    gl.uniform1f(U.u_m2merc, m2merc);

    // Absolute tiered world lattice (~5 km cells at typical zooms): puffs are
    // keyed to fixed ground positions, so the camera moves THROUGH the cloud
    // field instead of the field following the camera.
    const G = this.grid;
    const { cell, ic0 } = tieredLattice(spawn, G, 5, b);
    gl.uniform1i(U.u_grid, G);
    gl.uniform1i(U.u_layers, this.layers);
    gl.uniform2fv(U.u_cell, cell);
    gl.uniform2fv(U.u_ic0, ic0);

    // camera basis in ENU for billboarding
    const br = (this.map.getBearing() * Math.PI) / 180;
    const pt = (this.map.getPitch() * Math.PI) / 180;
    gl.uniform3fv(U.u_camRight, [Math.cos(br), -Math.sin(br), 0]);
    gl.uniform3fv(U.u_camUp, [Math.sin(br) * Math.cos(pt), Math.cos(br) * Math.cos(pt), Math.sin(pt)]);

    const light = this.lighting?.state ?? { sunDir: [0, 0, 1], sunColor: [1, 1, 1], ambient: 1 };
    gl.uniform3fv(U.u_sunDir, light.sunDir);
    gl.uniform3fv(U.u_sunColor, light.sunColor);
    gl.uniform1f(U.u_ambient, light.ambient);
    gl.uniform1f(U.u_density, this.density);
    gl.uniform1f(U.u_opacity, this.opacity);

    const { camX, camY, camAlt } = cameraDomainPos(this.map, b);
    gl.uniform2f(U.u_camPos, camX, camY);
    gl.uniform1f(U.u_camAlt, camAlt);
    gl.uniform1f(U.u_occlude, camAlt > 0 ? 1.0 : 0.0);
    const halfBoxKm = 0.5 * Math.max(
      (spawn.max[0] - spawn.min[0]) * lonSpan * 111.32 * Math.cos((center.lat * Math.PI) / 180),
      (spawn.max[1] - spawn.min[1]) * latSpan * 110.54,
    );
    // Clouds live higher than wind streaks, so let them reach a bit further
    // toward the horizon before fading.
    const cutoff = Math.max(halfBoxKm * 2.4, 4);
    gl.uniform1f(U.u_fadeNear, cutoff * 0.65);
    gl.uniform1f(U.u_fadeFar, cutoff * 1.1);

    // weather atlas + tiles
    const { cols, rows } = w.atlas;
    const off = (i) => [(i % cols) / cols, Math.floor(i / cols) / rows];
    gl.uniform1i(U.u_wxA, 8);
    gl.uniform1i(U.u_wxB, 9);
    gl.uniform1f(U.u_wxMix, pair.mix);
    gl.uniform2fv(U.u_wxTileScale, [1 / cols, 1 / rows]);
    gl.uniform2fv(U.u_wxClampMin, [0.5 / w.tile.width, 0.5 / w.tile.height]);
    gl.uniform2fv(U.u_wxClampMax, [1 - 0.5 / w.tile.width, 1 - 0.5 / w.tile.height]);
    gl.uniform2fv(U.u_cloudOff, off(w.tiles.cloud));
    gl.uniform2fv(U.u_layersOff, off(w.tiles.cloudLayers));
    gl.uniform1f(U.u_hMax, w.enc.cloudBase.max);
    gl.uniform1f(U.u_qcMax, w.enc.qc.max);
    // satellite + precip alignment (absent on an older data build)
    const hasSat = w.tiles.satellite != null && w.enc.irBT && w.enc.satTop;
    gl.uniform1f(U.u_hasSat, hasSat ? 1.0 : 0.0);
    if (hasSat) {
      gl.uniform2fv(U.u_satOff, off(w.tiles.satellite));
      gl.uniform2fv(U.u_radarOff, off(w.tiles.radar));
      gl.uniform2fv(U.u_precipOff, off(w.tiles.precip));
      gl.uniform1f(U.u_satTopMax, w.enc.satTop.max);
      gl.uniform1f(U.u_rateMax, w.enc.precipRate.max);
      gl.uniform1f(U.u_btMin, w.enc.irBT.min);
      gl.uniform1f(U.u_btMax, w.enc.irBT.max);
    }
    gl.uniform1f(U.u_time, (performance.now() / 1000) % 1000);
    gl.uniform2fv(U.u_qcOff, this.qcOff);
    gl.uniform1fv(U.u_qcHeight, this.qcHeight);
    gl.uniform1i(U.u_qcLen, this.qcLen);

    // terrain (shared with the wind layer's loader)
    const hi = this.meta.terrainHi;
    const terrTex = this.windLayer.frames?.terrainTex;
    gl.uniform1f(U.u_hasTerrHi, terrTex ? 1.0 : 0.0);
    gl.uniform1i(U.u_terrHi, 13);
    if (terrTex && hi) gl.uniform2f(U.u_terrHiRange, hi.hMin, hi.hMax);

    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, pair.texA);
    gl.activeTexture(gl.TEXTURE9);
    gl.bindTexture(gl.TEXTURE_2D, pair.texB);
    gl.activeTexture(gl.TEXTURE13);
    gl.bindTexture(gl.TEXTURE_2D, terrTex ?? this.blankTex);
    gl.activeTexture(gl.TEXTURE0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, G * G * this.layers * 6);

    gl.bindVertexArray(null);
    this.map.triggerRepaint();
  }
}
