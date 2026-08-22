// Wind speed color ramp and level naming helpers.

export const SPEED_MAX = 60; // m/s used for color normalization

// Perceptual-ish ramp: calm blue -> cyan -> green -> yellow -> orange -> red -> magenta
const STOPS = [
  [0.0, [63, 90, 190]],
  [0.17, [64, 175, 205]],
  [0.33, [95, 200, 120]],
  [0.5, [228, 210, 95]],
  [0.67, [240, 145, 65]],
  [0.83, [230, 75, 60]],
  [1.0, [220, 70, 180]],
];

export function rampColor(t) {
  t = Math.min(Math.max(t, 0), 1);
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const f = (t - t0) / (t1 - t0);
      return c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export function rampTextureData(n = 256) {
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = rampColor(i / (n - 1));
    data.set([r, g, b, 255], i * 4);
  }
  return data;
}

// Levels stacked in volumetric mode (by id), surface -> jet stream. Includes
// 80m and 1000 hPa so the low rungs of the deep ladder still have levels
// bracketing them over low ground, where 925 hPa is already 800 m up.
export const VOLUMETRIC_IDS = [
  "10m", "80m", "1000", "925", "850", "700", "500", "400", "300", "250", "200",
];

// Default stack: the air that actually meets the ground. The full troposphere
// reaches 12 km, so a quarter of the particles end up above every CONUS
// summit — physically right, but they read as a haze in the sky and bury the
// terrain interaction you came to look at. These levels top out near 4.5 km,
// just above the highest peaks, and pack the same particle budget into the
// layer where wind and mountains actually meet.
export const TERRAIN_IDS = ["10m", "80m", "925", "900", "850", "800", "750", "700", "650", "600"];

// Heights above ground (metres) the particles actually fly at. HRRR only
// carries 10 m and 80 m as real above-ground winds — everything above is a
// pressure surface whose height depends on the terrain under it — so the wind
// at each rung is interpolated from the model levels bracketing that height.
// The result is a 10 m wind that is 10 m off the deck everywhere, a 150 m wind
// at 150 m, and so on, rather than surfaces that drift relative to the ground.
// Spacing is tight low down, where terrain shapes the flow most.
// Surface layer only, 10-300 m above ground. This is deliberately thin: the
// stack's altitude range has to stay well UNDER the terrain relief you are
// looking at, or the upper rungs read as a flat slab hanging over the
// mountains rather than wind on them. Typical relief in view is ~1 km, so a
// 2 km-deep stack looked like a sheet with the ridges punched through it.
// At 300 m the whole column hugs the ground and the flow visibly drapes over
// ridges and pours through gaps. "Full column" restores the deep stack.
// 0.1-60 m. This has to stay far under the terrain relief in view or the top
// of the column reads as a slab hanging over the mountains — and at
// exaggeration 1, where nothing is stretched, even 300 m was ~30% of the
// Bridger relief and filled the upper frame from a low camera. At 60 m the
// whole column is a skin on the ground at any exaggeration.
export const AGL_LADDER = [0.1, 5, 10, 15, 20, 27, 34, 42, 50, 60];

// Model levels the ladder interpolates from: enough of the low pressure
// surfaces to bracket every rung, over terrain from sea level to 4.5 km.
// Only the lowest levels are needed to bracket a 10-300 m ladder; over high
// terrain the surface pressure is low, so keep enough of them that a summit
// still has a level above it to interpolate toward.
export const LADDER_SOURCE_IDS = [
  "10m", "80m", "1000", "975", "950", "925", "900", "875", "850", "825", "800", "750",
];

export function ladderSourceIndices(meta) {
  return LADDER_SOURCE_IDS
    .map((id) => meta.levels.find((l) => l.id === id))
    .filter(Boolean)
    .map((l) => l.index);
}

export function volumetricIndices(meta, ids = TERRAIN_IDS) {
  return ids
    .map((id) => meta.levels.find((l) => l.id === id))
    .filter(Boolean)
    .map((l) => l.index);
}

export function fullColumnIndices(meta) {
  return volumetricIndices(meta, VOLUMETRIC_IDS);
}

// Deep ladder for "Full column": same true-AGL treatment, up to jet level.
// Starts at the surface so the column is continuous from the ground rather
// than a separate deck overhead — with the old 10 m base the lowest rungs were
// still kilometres apart near the bottom, so from a low camera the stack read
// as a ceiling with clear air beneath it.
export const AGL_LADDER_FULL = [0.1, 20, 60, 150, 400, 1000, 2200, 4500, 7500, 11000];

export function levelName(level) {
  if (level.kind === "height_agl") return `${level.value} m (surface)`;
  const km = (level.heightMeters / 1000).toFixed(1);
  return `${level.value} hPa (~${km} km)`;
}

export function drawLegend(canvas) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  for (let x = 0; x < w; x++) {
    const [r, g, b] = rampColor(x / (w - 1));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, 0, 1, 14);
  }
  ctx.fillStyle = "#a8b6ca";
  ctx.font = "9px sans-serif";
  for (const ms of [0, 15, 30, 45, 60]) {
    const x = Math.min((ms / SPEED_MAX) * w, w - 12);
    ctx.fillText(String(ms), x, 24);
  }
  ctx.fillText("m/s", w - 20, 33);
}
