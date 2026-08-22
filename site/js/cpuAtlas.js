// CPU-side atlas decode: fetch a per-lead atlas PNG, draw it to a canvas, and
// sample tiles by pixel. One instance serves the wind atlas (PointCast wind
// profile) and one the weather atlas (conditions readout, radar overlay).

export class CpuAtlas {
  // frames: [{lead_hours, file}], atlas: {cols, rows}, tile: {width, height}
  constructor({ frames, atlas, tile, initTime, basePath = "data/", cacheMax = 3 }) {
    this.frames = frames;
    this.atlas = atlas;
    this.tile = tile;
    this.version = encodeURIComponent(initTime);
    this.basePath = basePath;
    this.cacheMax = cacheMax;
    this.pixels = new Map(); // lead -> ImageData
  }

  nearestFrame(t) {
    if (!this.frames?.length) return null;
    return this.frames.reduce((p, f) =>
      Math.abs(f.lead_hours - t) < Math.abs(p.lead_hours - t) ? f : p);
  }

  async decode(lead) {
    if (this.pixels.has(lead)) return this.pixels.get(lead);
    const entry = this.frames.find((f) => f.lead_hours === lead);
    if (!entry) return null;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `${this.basePath}${entry.file}?v=${this.version}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = this.tile.width * this.atlas.cols;
    c.height = this.tile.height * this.atlas.rows;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    this.pixels.set(lead, data);
    if (this.pixels.size > this.cacheMax) {
      this.pixels.delete(this.pixels.keys().next().value);
    }
    return data;
  }

  // Nearest-pixel [r, g, b, a] of tile `index` at normalized domain (nx, ny).
  sample(img, index, nx, ny) {
    const tw = this.tile.width, th = this.tile.height;
    const px = Math.min(tw - 1, Math.max(0, Math.round(nx * (tw - 1))));
    const py = Math.min(th - 1, Math.max(0, Math.round(ny * (th - 1))));
    const ax = (index % this.atlas.cols) * tw + px;
    const ay = Math.floor(index / this.atlas.cols) * th + py;
    const o = (ay * img.width + ax) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
  }
}

// Decode one quantized byte per a meta.json weather.enc entry. Returns null
// for the byte-0 "absent" sentinel of zeroIsNone channels (and for anything
// outside the domain the caller should have rejected via alpha first).
export function decodeEnc(byte, enc) {
  let t;
  if (enc.zeroIsNone) {
    if (byte === 0) return null;
    t = (byte - 1) / 254;
  } else {
    t = byte / 255;
  }
  switch (enc.kind) {
    case "linear": {
      const lo = enc.min ?? 0;
      return lo + t * (enc.max - lo);
    }
    case "sqrt":
      return t * t * enc.max;
    case "log10":
      return Math.pow(10, t * enc.div) - 1;
    default:
      return null;
  }
}
