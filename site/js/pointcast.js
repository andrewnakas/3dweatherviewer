// Click-to-sound: click the map, get the vertical wind profile ("point cast")
// at that location for the currently selected forecast hour.
//
// Decodes the atlas PNG on demand (browser-cached fetch) and renders a
// height-vs-speed profile: neutral line + dots in the app-wide speed ramp,
// direction arrows, ground shading, hover tooltip.

import { rampColor, SPEED_MAX, levelName } from "./atmosphere.js";

const INK = "#dde3ec", INK_MUTED = "#8fa0b8", GRID = "rgba(255,255,255,0.08)";

export class PointCast {
  constructor(map, layer, meta) {
    this.map = map;
    this.layer = layer;
    this.meta = meta;
    this.pixels = new Map(); // lead -> ImageData
    this.point = null;       // {lng, lat}
    this.profile = null;
    this.marker = null;
    this.el = document.getElementById("pointcast");
    this.canvas = document.getElementById("pointcast-canvas");
    this.titleEl = document.getElementById("pointcast-title");
    this.tipEl = document.getElementById("pointcast-tip");

    map.on("click", (e) => this.open(e.lngLat));
    document.getElementById("pointcast-close").addEventListener("click", () => this.close());
    window.addEventListener("windtime", () => { if (this.point) this.refresh(); });
    this.canvas.addEventListener("mousemove", (e) => this.hover(e));
    this.canvas.addEventListener("mouseleave", () => this.showTip(null));
  }

  norm(lngLat) {
    const b = this.meta.bounds;
    const x = (lngLat.lng - b.west) / (b.east - b.west);
    const y = (b.north - lngLat.lat) / (b.north - b.south);
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }

  async open(lngLat) {
    if (!this.norm(lngLat)) return;
    this.point = lngLat;
    if (!this.marker) {
      this.marker = new maplibregl.Marker({ color: "#2563eb" }).setLngLat(lngLat).addTo(this.map);
    } else {
      this.marker.setLngLat(lngLat);
    }
    this.el.hidden = false;
    await this.refresh();
  }

  close() {
    this.el.hidden = true;
    this.point = null;
    this.marker?.remove();
    this.marker = null;
  }

  async decode(lead) {
    if (this.pixels.has(lead)) return this.pixels.get(lead);
    const entry = this.meta.frames.find((f) => f.lead_hours === lead);
    if (!entry) return null;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `data/${entry.file}?v=${encodeURIComponent(this.meta.init_time)}`;
    await img.decode();
    const { cols, rows } = this.meta.atlas;
    const c = document.createElement("canvas");
    c.width = this.meta.tile.width * cols;
    c.height = this.meta.tile.height * rows;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    this.pixels.set(lead, data);
    if (this.pixels.size > 3) this.pixels.delete(this.pixels.keys().next().value);
    return data;
  }

  samples(img, n) {
    const { cols } = this.meta.atlas;
    const tw = this.meta.tile.width, th = this.meta.tile.height;
    const px = Math.min(tw - 1, Math.round(n.x * (tw - 1)));
    const py = Math.min(th - 1, Math.round(n.y * (th - 1)));
    const at = (index) => {
      const ax = (index % cols) * tw + px;
      const ay = Math.floor(index / cols) * th + py;
      const o = (ay * img.width + ax) * 4;
      return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
    };
    const t = this.meta.terrain;
    let ground = 0;
    if (t) {
      const [tr, tg, , ta] = at(t.index);
      if (ta > 128) ground = t.hMin + ((tr * 256 + tg) / 65535) * (t.hMax - t.hMin);
    }

    const levels = [];
    for (const lv of this.meta.levels) {
      const [r, g, b, a] = at(lv.index);
      if (a < 128) continue; // below ground or outside domain
      const u = lv.uMin + (r / 255) * (lv.uMax - lv.uMin);
      const v = lv.vMin + (g / 255) * (lv.vMax - lv.vMin);
      const w = (lv.wMin + (b / 255) * (lv.wMax - lv.wMin)) * (lv.wFactor ?? 0);
      const height = lv.kind === "height_agl" ? ground + lv.value : lv.heightMeters;
      levels.push({ lv, u, v, w, height, speed: Math.hypot(u, v) });
    }
    levels.sort((a, b) => a.height - b.height);
    return { ground, levels };
  }

  async refresh() {
    const lead = Math.round(Math.max(0, Math.min(this.layer.time,
      this.meta.frames[this.meta.frames.length - 1].lead_hours)));
    const near = this.meta.frames.reduce((p, f) =>
      Math.abs(f.lead_hours - lead) < Math.abs(p.lead_hours - lead) ? f : p);
    const img = await this.decode(near.lead_hours);
    if (!img || !this.point) return;
    const n = this.norm(this.point);
    if (!n) return;
    this.profile = this.samples(img, n);
    const { lng, lat } = this.point;
    // The profile stays raw model wind — it is the forecast sounding, and
    // terrain flow is a visualization-side downscaling of it, not new data.
    const gain = this.layer.windGain ?? 1;
    const note = gain !== 1
      ? ` · model wind (map is showing ${gain.toFixed(1)}× simulated)`
      : (this.layer.terrainPhysics ? " · model wind (map adds terrain flow)" : "");
    this.titleEl.textContent =
      `${lat.toFixed(2)}°, ${lng.toFixed(2)}° · +${near.lead_hours} h · ground ${Math.round(this.profile.ground)} m${note}`;
    this.draw();
  }

  layout() {
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    const m = { l: 44, r: 30, t: 8, b: 26 };
    const maxH = Math.max(...this.profile.levels.map((d) => d.height), 4000) * 1.06;
    const maxS = Math.max(10, Math.ceil(Math.max(...this.profile.levels.map((d) => d.speed)) * 1.15));
    const sx = (s) => m.l + (s / maxS) * (W - m.l - m.r);
    const sy = (h) => H - m.b - (h / maxH) * (H - m.t - m.b);
    return { dpr, W, H, m, maxH, maxS, sx, sy };
  }

  draw() {
    const p = this.profile;
    if (!p || !p.levels.length) return;
    const { dpr, W, H, m, maxH, maxS, sx, sy } = this.layout();
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = "10px -apple-system, sans-serif";

    // ground band
    ctx.fillStyle = "rgba(120, 100, 70, 0.25)";
    ctx.fillRect(m.l, sy(p.ground), W - m.l - m.r, H - m.b - sy(p.ground));

    // grid + axes (recessive)
    ctx.strokeStyle = GRID;
    ctx.fillStyle = INK_MUTED;
    ctx.lineWidth = 1;
    const kmStep = maxH > 9000 ? 3000 : 1500;
    for (let h = 0; h <= maxH; h += kmStep) {
      ctx.beginPath(); ctx.moveTo(m.l, sy(h)); ctx.lineTo(W - m.r, sy(h)); ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(`${(h / 1000).toFixed(h % 3000 ? 1 : 0)} km`, m.l - 5, sy(h) + 3);
    }
    const sStep = maxS > 30 ? 15 : 5;
    for (let s = 0; s <= maxS; s += sStep) {
      ctx.beginPath(); ctx.moveTo(sx(s), m.t); ctx.lineTo(sx(s), H - m.b); ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(String(s), sx(s), H - m.b + 12);
    }
    ctx.fillText("m/s", W - m.r + 14, H - m.b + 12);

    // profile line (neutral) + speed-ramp dots + direction arrows
    ctx.strokeStyle = "rgba(200, 210, 225, 0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    p.levels.forEach((d, i) => {
      const x = sx(d.speed), y = sy(d.height);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    for (const d of p.levels) {
      const x = sx(d.speed), y = sy(d.height);
      const [r, g, b] = rampColor(Math.min(d.speed / SPEED_MAX, 1));
      // direction arrow: points where the wind blows toward (screen north = up)
      const ang = Math.atan2(-d.v, d.u); // canvas y down
      ctx.strokeStyle = "rgba(200, 210, 225, 0.8)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(ang) * 9, y - Math.sin(ang) * 9);
      ctx.lineTo(x + Math.cos(ang) * 9, y + Math.sin(ang) * 9);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang) * 9, y + Math.sin(ang) * 9);
      ctx.lineTo(x + Math.cos(ang - 2.6) * 5, y + Math.sin(ang - 2.6) * 5);
      ctx.moveTo(x + Math.cos(ang) * 9, y + Math.sin(ang) * 9);
      ctx.lineTo(x + Math.cos(ang + 2.6) * 5, y + Math.sin(ang + 2.6) * 5);
      ctx.stroke();
      // dot with surface ring
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fill();
      ctx.strokeStyle = "#0c1018";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // direct-label the jet max
    const jet = p.levels.reduce((a, b) => (b.speed > a.speed ? b : a));
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.fillText(`${jet.speed.toFixed(0)} m/s`, sx(jet.speed) + 8, sy(jet.height) - 6);
  }

  hover(e) {
    if (!this.profile) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const { sx, sy } = this.layout();
    let best = null, bd = 1e9;
    for (const d of this.profile.levels) {
      const dx = sx(d.speed) - mx, dy = sy(d.height) - my;
      const dist = dx * dx + dy * dy;
      if (dist < bd) { bd = dist; best = d; }
    }
    this.draw();
    if (!best || bd > 900) { this.showTip(null); return; }
    const compass = "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split(" ");
    const from = compass[Math.round(((Math.atan2(-best.u, -best.v) * 180 / Math.PI + 360) % 360) / 22.5) % 16];
    this.showTip(
      `${levelName(best.lv)} · ${Math.round(best.height)} m · ` +
      `${best.speed.toFixed(1)} m/s from ${from} · w ${best.w >= 0 ? "+" : ""}${best.w.toFixed(2)} m/s`
    );
  }

  showTip(text) {
    this.tipEl.textContent = text ?? "";
    this.tipEl.style.visibility = text ? "visible" : "hidden";
  }
}
