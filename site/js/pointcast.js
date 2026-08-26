// Click-to-sound: click the map, get the vertical wind profile ("point cast")
// at that location for the currently selected forecast hour.
//
// Decodes the atlas PNG on demand (browser-cached fetch) and renders a
// height-vs-speed profile: neutral line + dots in the app-wide speed ramp,
// direction arrows, ground shading, hover tooltip.

import { rampColor, SPEED_MAX, levelName } from "./atmosphere.js";
import { CpuAtlas, decodeEnc } from "./cpuAtlas.js";

const INK = "#dde3ec", INK_MUTED = "#8fa0b8", GRID = "rgba(255,255,255,0.08)";

export class PointCast {
  constructor(map, layer, meta, wxAtlas = null) {
    this.map = map;
    this.layer = layer;
    this.meta = meta;
    this.windAtlas = new CpuAtlas({
      frames: meta.frames, atlas: meta.atlas, tile: meta.tile,
      initTime: meta.init_time,
    });
    // Surface conditions come from the weather atlas when the data build
    // provides one (shared decode cache with radar/lighting); the panel
    // degrades to wind-only against old data.
    this.wxAtlas = wxAtlas ?? (meta.weather ? new CpuAtlas({
      frames: meta.weather.frames, atlas: meta.weather.atlas,
      tile: meta.weather.tile, initTime: meta.init_time,
    }) : null);
    this.point = null;       // {lng, lat}
    this.profile = null;
    this.marker = null;
    this.el = document.getElementById("pointcast");
    this.canvas = document.getElementById("pointcast-canvas");
    this.titleEl = document.getElementById("pointcast-title");
    this.tipEl = document.getElementById("pointcast-tip");
    this.condEl = document.getElementById("pointcast-conditions");

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

  samples(img, n) {
    const at = (index) => this.windAtlas.sample(img, index, n.x, n.y);
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

  // Surface conditions at (nx, ny) from the weather atlas, or null.
  wxSample(img, n) {
    const w = this.meta.weather;
    const enc = w.enc;
    const at = (name) => this.wxAtlas.sample(img, w.tiles[name], n.x, n.y);
    const [pr, pf, pz, pa] = at("precip");
    if (pa < 128) return null; // outside the domain
    const [rr] = at("radar");
    const [cc, cb, ct] = at("cloud");
    const [lo, mid, hi] = at("cloudLayers");
    const [t2, td2, sw] = at("surface");
    const [gu, vi, sn] = at("surface2");
    return {
      rate: decodeEnc(pr, enc.precipRate),                 // mm/h
      frozen: decodeEnc(pf, enc.frozenFrac),               // %
      freezing: pz > 127,
      refl: decodeEnc(rr, enc.reflectivity),               // dBZ or null
      cloud: decodeEnc(cc, enc.cloudCover),                // %
      cloudBase: decodeEnc(cb, enc.cloudBase),             // m ASL or null
      cloudTop: decodeEnc(ct, enc.cloudTop),
      cloudLMH: [decodeEnc(lo, enc.cloudCover), decodeEnc(mid, enc.cloudCover),
                 decodeEnc(hi, enc.cloudCover)],
      t2m: decodeEnc(t2, enc.t2m),                         // degC
      td2m: decodeEnc(td2, enc.td2m),
      dswrf: decodeEnc(sw, enc.dswrf),                     // W/m^2
      gust: decodeEnc(gu, enc.gust),                       // m/s
      visibility: decodeEnc(vi, enc.visibility),           // m
      snowDepth: decodeEnc(sn, enc.snowDepth),             // m
    };
  }

  precipLabel(c) {
    if (c.rate == null || c.rate < 0.05) return null;
    let kind = "rain";
    if (c.freezing) kind = "freezing rain / ice";
    else if (c.frozen > 50) kind = "snow";
    else if (c.frozen > 10) kind = "wintry mix";
    return `${kind} · ${c.rate < 1 ? c.rate.toFixed(2) : c.rate.toFixed(1)} mm/h`;
  }

  renderConditions(c, ground) {
    if (!this.condEl) return;
    if (!c || c.t2m == null) { this.condEl.hidden = true; return; }
    const f = (v) => (v * 9 / 5 + 32).toFixed(0);
    // Magnus RH from t/td — the atlas carries the pair, not RH itself.
    const es = (t) => Math.exp((17.625 * t) / (243.04 + t));
    const rh = Math.min(100, 100 * es(c.td2m) / es(c.t2m));
    const rows = [];
    rows.push(["Temp", `${c.t2m.toFixed(1)} °C / ${f(c.t2m)} °F · dew ${c.td2m.toFixed(1)} °C · RH ${rh.toFixed(0)}%`]);
    const pl = this.precipLabel(c);
    if (pl) rows.push(["Precip", pl + (c.refl != null ? ` · ${c.refl.toFixed(0)} dBZ` : "")]);
    else if (c.refl != null && c.refl > 5) rows.push(["Radar", `${c.refl.toFixed(0)} dBZ echo`]);
    const lmh = c.cloudLMH.map((v) => `${v?.toFixed(0) ?? 0}`).join("/");
    let cloudTxt = `${c.cloud?.toFixed(0) ?? 0}% (L/M/H ${lmh}%)`;
    // base heights are infilled everywhere, so only quote one under real cloud
    if (c.cloudBase != null && (c.cloud ?? 0) > 5) {
      const agl = Math.max(0, c.cloudBase - ground);
      cloudTxt += ` · base ${agl >= 1000 ? (agl / 1000).toFixed(1) + " km" : Math.round(agl) + " m"} AGL`;
    }
    rows.push(["Cloud", cloudTxt]);
    const bits = [`gust ${c.gust?.toFixed(0) ?? 0} m/s`];
    if (c.visibility != null && c.visibility < 15000) {
      bits.push(`vis ${(c.visibility / 1000).toFixed(c.visibility < 2000 ? 1 : 0)} km`);
    }
    if (c.snowDepth != null && c.snowDepth > 0.01) bits.push(`snow ${(c.snowDepth * 100).toFixed(0)} cm`);
    if (c.dswrf != null && c.dswrf > 1) bits.push(`sun ${c.dswrf.toFixed(0)} W/m²`);
    rows.push(["Now", bits.join(" · ")]);
    this.condEl.innerHTML = rows
      .map(([k, v]) => `<span class="ck">${k}</span><span class="cv">${v}</span>`)
      .join("");
    this.condEl.hidden = false;
  }

  async refresh() {
    const lead = Math.round(Math.max(0, Math.min(this.layer.time,
      this.meta.frames[this.meta.frames.length - 1].lead_hours)));
    const near = this.meta.frames.reduce((p, f) =>
      Math.abs(f.lead_hours - lead) < Math.abs(p.lead_hours - lead) ? f : p);
    const img = await this.windAtlas.decode(near.lead_hours);
    if (!img || !this.point) return;
    const n = this.norm(this.point);
    if (!n) return;
    this.profile = this.samples(img, n);
    if (this.wxAtlas) {
      try {
        const wf = this.wxAtlas.nearestFrame(near.lead_hours);
        const wimg = wf && await this.wxAtlas.decode(wf.lead_hours);
        this.renderConditions(wimg && this.wxSample(wimg, n), this.profile.ground);
      } catch { this.condEl && (this.condEl.hidden = true); }
    }
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
