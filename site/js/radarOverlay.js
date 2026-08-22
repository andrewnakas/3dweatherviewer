// Composite-reflectivity overlay, draped on the 3D terrain.
//
// Implemented as a MapLibre `image` source fed from a CPU-colorized canvas
// rather than a custom GL layer: raster sources drape over 3D terrain for
// free, which a custom layer cannot do without access to the terrain depth
// buffer. Colorizing a 450x265 tile on the CPU is trivial next to that.

import { CpuAtlas, decodeEnc } from "./cpuAtlas.js";

// NWS-style reflectivity ramp: [dBZ, r, g, b].
const DBZ_STOPS = [
  [5, 4, 233, 231], [10, 1, 159, 244], [15, 3, 0, 244],
  [20, 2, 253, 2], [25, 1, 197, 1], [30, 0, 142, 0],
  [35, 253, 248, 2], [40, 229, 188, 0], [45, 253, 149, 0],
  [50, 253, 0, 0], [55, 212, 0, 0], [60, 188, 0, 0],
  [65, 248, 0, 253], [70, 152, 84, 198], [75, 255, 255, 255],
];
const DBZ_MIN_SHOWN = 5;

export function dbzColor(dbz) {
  if (dbz < DBZ_MIN_SHOWN) return null;
  let c = DBZ_STOPS[0];
  for (const s of DBZ_STOPS) { if (dbz >= s[0]) c = s; else break; }
  return [c[1], c[2], c[3]];
}

const mercY = (latDeg) => {
  const s = Math.sin((latDeg * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

export class RadarOverlay {
  constructor(map, meta, wxAtlas) {
    this.map = map;
    this.meta = meta;
    this.wx = wxAtlas; // shared CpuAtlas over the weather frames
    // Modest default: the drape is map context now — the 3D storm-cell layer
    // carries the volumetric read of the radar.
    this.opacity = 0.5;
    this.lastLead = null;
    this.added = false;
    this._pending = null;

    const b = meta.bounds;
    const w = meta.weather;
    // Output canvas: rows uniform in MERCATOR y. An image source is mapped
    // linearly in mercator between its corner coordinates, but the atlas rows
    // are uniform in latitude — over 21-52°N feeding it directly misplaces
    // echoes by tens of km. Resample by a per-row lookup instead.
    const tw = w.tile.width, th = w.tile.height;
    this.W = tw;
    const myN = mercY(b.north), myS = mercY(b.south);
    const aspect = (myS - myN) / ((b.east - b.west) / 360);
    this.H = Math.max(th, Math.round(this.W * aspect));
    this.rowLut = new Int32Array(this.H);
    for (let j = 0; j < this.H; j++) {
      const my = myN + ((j + 0.5) / this.H) * (myS - myN);
      // inverse web mercator -> latitude
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
      const srcRow = ((b.north - lat) / (b.north - b.south)) * (th - 1);
      this.rowLut[j] = Math.max(0, Math.min(th - 1, Math.round(srcRow)));
    }
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.W;
    this.canvas.height = this.H;

    const onTime = (e) => this.setTime(e.detail);
    window.addEventListener("windtime", onTime);
  }

  // Debounced: scrubbing the slider fires many windtime events per second and
  // a decode + repaint per event would stall the drag.
  setTime(t) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.update(t), 120);
  }

  async update(t) {
    const near = this.wx.nearestFrame(t);
    if (!near) return;
    if (this._pending != null) { this._pending = near.lead_hours; return; }
    this._pending = near.lead_hours;
    try {
      // Drain: a newer request may land while this decode is in flight.
      while (this._pending != null) {
        const lead = this._pending;
        if (lead === this.lastLead && this.added) { break; }
        const img = await this.wx.decode(lead);
        if (img) {
          this.colorize(img);
          this.publish();
          this.lastLead = lead;
        }
        this._pending = this._pending === lead ? null : this._pending;
      }
    } finally {
      this._pending = null;
    }
  }

  colorize(img) {
    const w = this.meta.weather;
    const enc = w.enc.reflectivity;
    const tIdx = w.tiles.radar;
    const tw = w.tile.width, th = w.tile.height;
    const tx0 = (tIdx % w.atlas.cols) * tw;
    const ty0 = Math.floor(tIdx / w.atlas.cols) * th;
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    const out = ctx.createImageData(this.W, this.H);
    const od = out.data, sd = img.data, sw = img.width;
    for (let j = 0; j < this.H; j++) {
      const sy = ty0 + this.rowLut[j];
      const rowOff = sy * sw;
      for (let i = 0; i < this.W; i++) {
        const so = (rowOff + tx0 + i) * 4;
        const a = sd[so + 3];
        if (a < 128) continue; // outside domain -> transparent
        const dbz = decodeEnc(sd[so], enc);
        if (dbz == null) continue; // no echo
        const c = dbzColor(dbz);
        if (!c) continue;
        const oo = (j * this.W + i) * 4;
        od[oo] = c[0]; od[oo + 1] = c[1]; od[oo + 2] = c[2];
        // slightly stronger where it matters
        od[oo + 3] = Math.round(255 * Math.min(1, 0.75 + dbz / 200));
      }
    }
    ctx.putImageData(out, 0, 0);
  }

  publish() {
    const b = this.meta.bounds;
    const url = this.canvas.toDataURL();
    const coords = [
      [b.west, b.north], [b.east, b.north],
      [b.east, b.south], [b.west, b.south],
    ];
    if (!this.added) {
      this.map.addSource("radar", { type: "image", url, coordinates: coords });
      const before = this.map.getLayer("labels") ? "labels" : undefined;
      this.map.addLayer({
        id: "radar-layer",
        type: "raster",
        source: "radar",
        paint: {
          "raster-opacity": this.opacity,
          "raster-fade-duration": 0,
          "raster-resampling": "linear",
        },
      }, before);
      this.added = true;
    } else {
      this.map.getSource("radar").updateImage({ url, coordinates: coords });
    }
  }

  setOpacity(v) {
    this.opacity = v;
    if (this.added) this.map.setPaintProperty("radar-layer", "raster-opacity", v);
  }

  setVisible(on) {
    if (this.added) {
      this.map.setLayoutProperty("radar-layer", "visibility", on ? "visible" : "none");
    }
    this.enabled = on;
  }
}
