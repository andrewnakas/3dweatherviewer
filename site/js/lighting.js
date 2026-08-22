// Sun-driven sky and lighting: the single owner of "what time is it in the
// sky". Computes the sun for the forecast valid time at the map center and
// drives (a) the MapLibre sky, (b) day/night dimming of the imagery basemap,
// (c) a lighting state {sunDir, sunColor, ambient, nightFactor} that the
// precip and cloud layers read every frame.

import { sunPosition } from "./sun.js";
import { decodeEnc } from "./cpuAtlas.js";

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const rgb = (c) => `rgb(${c.map((v) => Math.round(clamp01(v) * 255)).join(",")})`;

// Sky keyframes by sun elevation (degrees): night, civil twilight, golden
// hour, day. Colors picked for the dark satellite-imagery basemap.
const KEYS = [
  { el: -12, sky: [0.02, 0.03, 0.06], horizon: [0.04, 0.06, 0.12], sun: [0.25, 0.30, 0.45], ambient: 0.30 },
  { el: -6,  sky: [0.07, 0.10, 0.22], horizon: [0.45, 0.28, 0.38], sun: [0.60, 0.55, 0.65], ambient: 0.45 },
  { el: 0,   sky: [0.18, 0.30, 0.50], horizon: [0.95, 0.63, 0.35], sun: [1.00, 0.72, 0.45], ambient: 0.70 },
  { el: 10,  sky: [0.29, 0.56, 0.85], horizon: [0.78, 0.86, 0.94], sun: [1.00, 0.98, 0.92], ambient: 1.00 },
];

function skyAt(el) {
  if (el <= KEYS[0].el) return KEYS[0];
  if (el >= KEYS[KEYS.length - 1].el) return KEYS[KEYS.length - 1];
  for (let i = 1; i < KEYS.length; i++) {
    if (el <= KEYS[i].el) {
      const a = KEYS[i - 1], b = KEYS[i];
      const t = smooth(a.el, b.el, el);
      return {
        el,
        sky: lerp3(a.sky, b.sky, t),
        horizon: lerp3(a.horizon, b.horizon, t),
        sun: lerp3(a.sun, b.sun, t),
        ambient: a.ambient + (b.ambient - a.ambient) * t,
      };
    }
  }
  return KEYS[KEYS.length - 1];
}

export class Lighting {
  constructor(map, meta, wxAtlas = null) {
    this.map = map;
    this.meta = meta;
    this.wx = wxAtlas; // optional shared CpuAtlas for DSWRF cloud dimming
    this.enabled = true;
    this.time = 0;
    this.initMs = Date.parse(meta.init_time);
    this.cloudDim = 1; // async DSWRF factor, folded into the next update
    // What other layers consume. sunDir is east/north/up, normalized; below
    // the horizon it keeps pointing at the geometric sun so twilight clouds
    // are still lit from the right side.
    this.state = {
      sunDir: [0, 0, 1], sunColor: [1, 1, 1], ambient: 1,
      nightFactor: 0, elevationDeg: 90,
    };
    this._last = 0;
    window.addEventListener("windtime", (e) => { this.time = e.detail; this.update(); });
    map.on("moveend", () => this.update(true));
    this.update(true);
  }

  validDate() {
    return new Date(this.initMs + this.time * 3600e3);
  }

  // Playback dispatches windtime every animation frame; recomputing a sky
  // gradient that fast is wasted work, so throttle to ~6 Hz (the sun moves
  // 0.25 deg per simulated minute at most).
  update(force = false) {
    const now = performance.now();
    if (!force && now - this._last < 160) return;
    this._last = now;

    const c = this.map.getCenter();
    const { azimuthDeg, elevationDeg } = sunPosition(this.validDate(), c.lat, c.lng);
    const az = (azimuthDeg * Math.PI) / 180, el = (elevationDeg * Math.PI) / 180;
    const k = skyAt(elevationDeg);
    const night = 1 - smooth(-10, 5, elevationDeg);

    this.state = {
      sunDir: [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)],
      sunColor: k.sun,
      ambient: k.ambient,
      nightFactor: night,
      elevationDeg,
      azimuthDeg,
    };

    if (!this.enabled) return;
    this.applySky(k);
    this.applyGround(elevationDeg);
    this.sampleCloudDim(elevationDeg);
  }

  applySky(k) {
    // setSky ships in MapLibre 4.x; guard so an older build just skips it.
    try {
      this.map.setSky({
        "sky-color": rgb(k.sky),
        "horizon-color": rgb(k.horizon),
        "fog-color": rgb(lerp3(k.horizon, k.sky, 0.5)),
        "sky-horizon-blend": 0.7,
        "horizon-fog-blend": 0.6,
        "fog-ground-blend": 0.9,
        "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 10, 1, 12, 0.6],
      });
    } catch { /* no sky support */ }
  }

  applyGround(elevationDeg) {
    // Imagery day/night: full brightness above +10 deg, floor below civil
    // twilight. DSWRF (clouds) can only darken the daytime end.
    const day = smooth(-6, 10, elevationDeg);
    const b = (0.22 + 0.78 * day) * (this.enabled ? this.cloudDim : 1);
    try {
      this.map.setPaintProperty("imagery", "raster-brightness-max", Math.max(0.15, b));
      this.map.setPaintProperty("imagery", "raster-saturation", -0.45 * (1 - day));
    } catch { /* style may not have the imagery layer */ }
  }

  // Cloud-attenuated sunlight: compare the forecast downward shortwave at the
  // map center against a clear-sky estimate for this sun elevation, and let
  // heavy overcast dim the ground. Async and best-effort — the factor folds
  // into the next update.
  sampleCloudDim(elevationDeg) {
    if (!this.wx || elevationDeg < 5) { this.cloudDim = 1; return; }
    const near = this.wx.nearestFrame(this.time);
    if (!near) return;
    this.wx.decode(near.lead_hours).then((img) => {
      if (!img) return;
      const w = this.meta.weather, b = this.meta.bounds;
      const c = this.map.getCenter();
      const nx = (c.lng - b.west) / (b.east - b.west);
      const ny = (b.north - c.lat) / (b.north - b.south);
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) { this.cloudDim = 1; return; }
      const [, , sw, a] = this.wx.sample(img, w.tiles.surface, nx, ny);
      if (a < 128) { this.cloudDim = 1; return; }
      const dswrf = decodeEnc(sw, w.enc.dswrf) ?? 0;
      const clear = 1100 * Math.pow(Math.sin((elevationDeg * Math.PI) / 180), 1.2) + 30;
      this.cloudDim = 0.72 + 0.28 * clamp01(dswrf / clear);
    }).catch(() => { this.cloudDim = 1; });
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      // Restore a neutral daytime look.
      try {
        this.map.setSky({
          "sky-color": rgb(KEYS[3].sky),
          "horizon-color": rgb(KEYS[3].horizon),
          "fog-color": rgb(KEYS[3].horizon),
          "sky-horizon-blend": 0.7,
        });
        this.map.setPaintProperty("imagery", "raster-brightness-max", 1);
        this.map.setPaintProperty("imagery", "raster-saturation", 0);
      } catch { /* ignore */ }
      this.state = { ...this.state, sunColor: [1, 1, 1], ambient: 1, nightFactor: 0 };
    } else {
      this.update(true);
    }
  }
}
