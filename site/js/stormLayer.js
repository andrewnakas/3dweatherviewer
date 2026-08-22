// MapLibre custom layer: 3D storm cells — the radar volume. Stateless like
// the cloud layer: every lattice cell whose radar tile shows a real echo
// draws a translucent curtain from the terrain up to the cell's echo-top
// height, banded in dBZ colors and weighted by VIL. Where the 2D radar drape
// paints the map, these towers stand IN the scene at the storm's actual
// height, so a supercell reads as a 12 km wall instead of a red stain.
//
// Texture units: 8/9 weather atlas A/B, 13 hi-res terrain (same convention
// as the cloud layer; separate draw calls make sharing safe).

import { STORM_VERT, STORM_FRAG } from "./stormShaders.js";
import { compile, uniforms, makeBlankTex, computeSpawnBounds, cameraDomainPos, tieredLattice } from "./glutil.js";

export class StormLayer {
  constructor(map, meta, windLayer, lighting, wxShared, opts = {}) {
    this.id = "storm-cells";
    this.type = "custom";
    this.renderingMode = "3d";
    this.map = map;
    this.meta = meta;
    this.windLayer = windLayer;
    this.lighting = lighting;
    this.wxShared = wxShared;
    this.enabled = opts.enabled ?? true;
    this.time = 0;
    this.opacity = 1.0;
    this.grid = opts.grid ?? 96; // finer than clouds: storm cores are small
    window.addEventListener("windtime", (e) => { this.time = e.detail; });
  }

  onAdd(map, gl) {
    if (!(gl instanceof WebGL2RenderingContext)) throw new Error("WebGL2 required");
    this.gl = gl;
    this.prog = compile(gl, STORM_VERT, STORM_FRAG);
    this.U = uniforms(gl, this.prog);
    this.vao = gl.createVertexArray();
    this.blankTex = makeBlankTex(gl);
    this.wxFrames = this.wxShared.get(gl);
  }

  onRemove() { /* GL objects reclaimed with the context */ }

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

    // Absolute tiered lattice (~4 km cells) — towers stay pinned to the
    // ground as the camera moves, same scheme as the cloud layer.
    const G = this.grid;
    const { cell, ic0 } = tieredLattice(spawn, G, 4, b);
    gl.uniform1i(U.u_grid, G);
    gl.uniform2fv(U.u_cell, cell);
    gl.uniform2fv(U.u_ic0, ic0);

    const br = (this.map.getBearing() * Math.PI) / 180;
    gl.uniform3fv(U.u_camRight, [Math.cos(br), -Math.sin(br), 0]);
    gl.uniform1f(U.u_ambient, this.lighting?.state?.ambient ?? 1);
    gl.uniform1f(U.u_opacity, this.opacity);

    const { camX, camY, camAlt } = cameraDomainPos(this.map, b);
    gl.uniform2f(U.u_camPos, camX, camY);
    gl.uniform1f(U.u_camAlt, camAlt);
    gl.uniform1f(U.u_occlude, camAlt > 0 ? 1.0 : 0.0);
    const halfBoxKm = 0.5 * Math.max(
      (spawn.max[0] - spawn.min[0]) * lonSpan * 111.32 * Math.cos((center.lat * Math.PI) / 180),
      (spawn.max[1] - spawn.min[1]) * latSpan * 110.54,
    );
    const cutoff = Math.max(halfBoxKm * 2.4, 4);
    gl.uniform1f(U.u_fadeNear, cutoff * 0.65);
    gl.uniform1f(U.u_fadeFar, cutoff * 1.1);

    const { cols, rows } = w.atlas;
    gl.uniform1i(U.u_wxA, 8);
    gl.uniform1i(U.u_wxB, 9);
    gl.uniform1f(U.u_wxMix, pair.mix);
    gl.uniform2fv(U.u_wxTileScale, [1 / cols, 1 / rows]);
    gl.uniform2fv(U.u_wxClampMin, [0.5 / w.tile.width, 0.5 / w.tile.height]);
    gl.uniform2fv(U.u_wxClampMax, [1 - 0.5 / w.tile.width, 1 - 0.5 / w.tile.height]);
    gl.uniform2fv(U.u_radarOff, [
      (w.tiles.radar % cols) / cols, Math.floor(w.tiles.radar / cols) / rows,
    ]);
    gl.uniform1f(U.u_topMax, w.enc.echoTop.max);
    gl.uniform1f(U.u_vilMax, w.enc.vil.max);

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
    gl.drawArrays(gl.TRIANGLES, 0, G * G * 6);

    gl.bindVertexArray(null);
    this.map.triggerRepaint();
  }
}
