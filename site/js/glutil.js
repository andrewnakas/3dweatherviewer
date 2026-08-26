// Shared WebGL2 helpers used by every custom layer (wind, precip, clouds).

// Compile + link a program, injecting optional #define lines right after the
// #version directive so one GLSL source serves multiple precision paths.
export function compile(gl, vertSrc, fragSrc, defines = "") {
  const inject = (src) => src.replace("#version 300 es", `#version 300 es\n${defines}`);
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, inject(vertSrc)], [gl.FRAGMENT_SHADER, inject(fragSrc)]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error("shader: " + gl.getShaderInfoLog(sh));
    }
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error("link: " + gl.getProgramInfoLog(prog));
  }
  return prog;
}

// Reflect every active uniform into a name -> location map (array uniforms are
// keyed without the trailing "[0]"), so shaders need no JS location bookkeeping.
export function uniforms(gl, prog) {
  const out = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    out[info.name.replace("[0]", "")] = gl.getUniformLocation(prog, info.name);
  }
  return out;
}

// 1x1 stand-in so a declared sampler stays complete before its texture loads.
export function makeBlankTex(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 128, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

// Respawn/placement region following the viewport (padded): a box in real
// distance centred on what the middle of the screen is looking at, clipped to
// the raw view bounds. Shared by wind, precip and cloud layers so all three
// populate the same patch of ground. See the long comments inline — every
// constant here was tuned against a specific visible failure.
export function computeSpawnBounds(map, b) {
  const lonSpan = b.east - b.west;
  const latSpan = b.north - b.south;
  try {
    const mb = map.getBounds();
    let x0 = (mb.getWest() - b.west) / lonSpan;
    let x1 = (mb.getEast() - b.west) / lonSpan;
    let y0 = (b.north - mb.getNorth()) / latSpan;
    let y1 = (b.north - mb.getSouth()) / latSpan;

    // At a high pitch getBounds() runs to the horizon, and the visible
    // ground area grows with the square of distance — so uniform seeding
    // over those bounds puts almost every particle in the far distance,
    // where it is a thin haze near the skyline, and leaves the terrain in
    // front of the camera bare. Anchor the box on what the middle of the
    // screen is actually pointing at and size it from the near field.
    const cam = map.unproject([
      map.getCanvas().clientWidth / 2,
      map.getCanvas().clientHeight * 0.5,
    ]);
    const cx = (cam.lng - b.west) / lonSpan;
    const cy = (b.north - cam.lat) / latSpan;
    // Size the box from the ground the camera actually sees. Measuring only
    // the screen's width collapses it on a tall phone viewport, where the
    // view is narrow across but reaches far up-screen.
    const W = map.getCanvas().clientWidth;
    const H = map.getCanvas().clientHeight;
    const bl = map.unproject([0, H]);
    const br = map.unproject([W, H]);
    const nearPt = map.unproject([W / 2, H]);
    const acrossDeg = Math.abs(br.lng - bl.lng) / lonSpan;
    const upDeg = Math.abs(cam.lat - nearPt.lat) / latSpan;
    // Work in kilometres, not normalised units: the two axes are normalised by
    // different domain spans, so one scalar "reach" applied to both would make
    // the box wider than deep in real distance.
    const kmPerLonUnit = lonSpan * 111.32 * Math.cos((cam.lat * Math.PI) / 180);
    const kmPerLatUnit = latSpan * 110.54;
    const reachKm = Math.max(acrossDeg * kmPerLonUnit, upDeg * kmPerLatUnit, 0.2) * 1.6;
    const rx = reachKm / kmPerLonUnit;
    const ry = reachKm / kmPerLatUnit;
    x0 = Math.max(x0, cx - rx); x1 = Math.min(x1, cx + rx);
    y0 = Math.max(y0, cy - ry); y1 = Math.min(y1, cy + ry);
    if (!(x1 > x0 && y1 > y0)) {
      // Degenerate (camera pointing off-domain) — fall back to the raw view.
      x0 = Math.max(0, (mb.getWest() - b.west) / lonSpan);
      x1 = Math.min(1, (mb.getEast() - b.west) / lonSpan);
      y0 = Math.max(0, (b.north - mb.getNorth()) / latSpan);
      y1 = Math.min(1, (b.north - mb.getSouth()) / latSpan);
    }
    const padX = (x1 - x0) * 0.15, padY = (y1 - y0) * 0.15;
    x0 = Math.max(0, x0 - padX); x1 = Math.min(1, x1 + padX);
    y0 = Math.max(0, y0 - padY); y1 = Math.min(1, y1 + padY);
    // Only reject a box that is empty or inverted — a zoomed-in view is a tiny
    // fraction of the domain and that is exactly when viewport-following
    // matters most.
    if (x1 > x0 && y1 > y0) return { min: [x0, y0], max: [x1, y1] };
  } catch { /* fall through */ }
  return { min: [0, 0], max: [1, 1] };
}

// Absolute world-space lattice for stateless billboard layers (clouds, storm
// cells). Cells are FIXED in the world — baseKm at typical zooms, doubling in
// power-of-two tiers when the view outgrows the G x G grid — so the objects
// derived from cell coordinates stay pinned to the ground as the camera pans
// and zooms. A camera-relative lattice re-anchors every frame, which reads as
// a texture pasted over the terrain instead of things IN the scene.
export function tieredLattice(spawn, G, baseKm, b) {
  const lonSpan = b.east - b.west;
  const latSpan = b.north - b.south;
  const refCos = Math.cos((38 * Math.PI) / 180); // fixed ref latitude: cells must not resize on pan
  const baseX = baseKm / (lonSpan * 111.32 * refCos);
  const baseY = baseKm / (latSpan * 110.54);
  const spanX = spawn.max[0] - spawn.min[0];
  const spanY = spawn.max[1] - spawn.min[1];
  // Tiers run BOTH ways from the base cell. Zoomed out they double until the
  // G x G grid still spans the view (otherwise the field ends mid-screen);
  // zoomed in they halve, so a close-up gets fine detail instead of a couple
  // of cells the size of the whole viewport. Bounds keep the cell sane.
  const need = Math.max(spanX / (G * baseX), spanY / (G * baseY), 1e-9);
  const tier = Math.pow(2, Math.min(8, Math.max(-4, Math.ceil(Math.log2(need)))));
  const cell = [baseX * tier, baseY * tier];
  const ic0 = [Math.floor(spawn.min[0] / cell[0]), Math.floor(spawn.min[1] / cell[1])];
  return { cell, ic0 };
}

// Camera eye point in normalized domain coords + altitude (m ASL), for the
// terrain occlusion raymarch. Falls back to "occlusion off" when the transform
// cannot provide it.
export function cameraDomainPos(map, b) {
  const lonSpan = b.east - b.west;
  const latSpan = b.north - b.south;
  let camX = 0.5, camY = 0.5, camAlt = 0;
  try {
    const cam = map.transform.getCameraPosition();
    camAlt = cam.altitude;
    camX = (cam.lngLat.lng - b.west) / lonSpan;
    camY = (b.north - cam.lngLat.lat) / latSpan;
  } catch { camAlt = 0; }
  return { camX, camY, camAlt };
}
