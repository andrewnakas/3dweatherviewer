// DOM control wiring.

import {
  levelName, drawLegend, drawRadarLegend, volumetricIndices, fullColumnIndices,
  ladderSourceIndices, bl3dIndices, AGL_LADDER, AGL_LADDER_FULL, AGL_LADDER_3D,
} from "./atmosphere.js";
import { dbzColor } from "./radarOverlay.js";

export function initUI(map, layer, meta, weather = null) {
  const $ = (id) => document.getElementById(id);

  // --- header ---
  const init = new Date(meta.init_time);
  $("init-time").textContent = `init ${init.toISOString().slice(0, 13)}Z`;

  // --- level selector ---
  const sel = $("level-select");
  const groups = { Surface: [], "Pressure levels": [] };
  for (const lv of meta.levels) {
    groups[lv.kind === "height_agl" ? "Surface" : "Pressure levels"].push(lv);
  }
  for (const [name, levels] of Object.entries(groups)) {
    const og = document.createElement("optgroup");
    og.label = name;
    for (const lv of levels) {
      const opt = document.createElement("option");
      opt.value = lv.index;
      opt.textContent = levelName(lv);
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  sel.value = String(layer.volumetric
    ? meta.levels.findIndex((l) => l.id === "10m")
    : layer.levelIndices[0]);
  sel.addEventListener("change", () => layer.setLevels([Number(sel.value)]));

  // --- volumetric toggle + wind mode ---
  const vol = $("volumetric");
  const full = $("full-column");
  const gh = $("ground-hug");
  // Three wind modes, resolved from the two checkboxes:
  //   full column     -> 11 km ladder, upper-air levels
  //   surface skin    -> 60 m ladder painted onto the ground (ground-hug)
  //   3D boundary layer (default) -> 2 km ladder at true heights, where the
  //   terrain-flow physics stays visible
  // With the AGL ladder the stack is the set of model levels the rungs
  // interpolate from, not the rungs themselves — returning the plain
  // volumetric list here left the low rungs without levels to bracket them.
  const stackIndices = () => {
    if (full.checked) return fullColumnIndices(meta);
    if (!layer.useAglLadder) return volumetricIndices(meta);
    return gh.checked ? ladderSourceIndices(meta) : bl3dIndices(meta);
  };
  const applyWindMode = () => {
    layer.fullColumn = full.checked;
    layer.groundHug = gh.checked && !full.checked;
    layer.aglLadder = full.checked ? AGL_LADDER_FULL
      : gh.checked ? AGL_LADDER : AGL_LADDER_3D;
    if (vol.checked) layer.setLevels(stackIndices());
  };
  vol.checked = layer.volumetric;
  // Browsers restore checkbox state across reloads, so these must be forced
  // to match the layer. Left unsynced, a restored "Full column" tick swapped
  // in the 11 km ladder while the layer still thought it was on the surface
  // one — the wind then sat kilometres up and read as a ceiling.
  full.checked = !!layer.fullColumn;
  gh.checked = !!layer.groundHug;
  applyWindMode();
  sel.disabled = vol.checked;
  full.disabled = !vol.checked;
  vol.addEventListener("change", () => {
    sel.disabled = vol.checked;
    full.disabled = !vol.checked;
    layer.volumetric = vol.checked;
    layer.setLevels(vol.checked ? stackIndices() : [Number(sel.value)]);
  });
  full.addEventListener("change", applyWindMode);
  gh.addEventListener("change", applyWindMode);

  // --- terrain flow physics ---
  const tf = $("terrain-flow");
  tf.checked = layer.terrainPhysics;
  tf.addEventListener("change", () => { layer.terrainPhysics = tf.checked; });

  // --- wind altitude scale ---
  // Follows terrain exaggeration until the user moves it, so altitude is drawn
  // at the same scale as the mountains and particles meet the peaks.
  const alt = $("alt-scale");
  let altPinned = false;
  const showAlt = () => {
    alt.value = String(layer.altScale);
    $("alt-val").textContent = `${Number(layer.altScale).toFixed(1)}×`;
  };
  showAlt();
  alt.addEventListener("input", () => {
    altPinned = true;
    layer.altScale = Number(alt.value);
    $("alt-val").textContent = `${Number(alt.value).toFixed(1)}×`;
  });

  // --- panel collapse ---
  const panel = document.getElementById("panel");
  $("panel-toggle").addEventListener("click", () => panel.classList.toggle("collapsed"));
  if (window.innerWidth < 700) panel.classList.add("collapsed");

  // --- particle count ---
  const pc = $("particles-select");
  pc.value = String(layer.particleCount);
  pc.addEventListener("change", () => layer.setParticleCount(Number(pc.value)));

  // --- terrain exaggeration ---
  const ex = $("exaggeration");
  ex.addEventListener("input", () => {
    const v = Number(ex.value);
    $("exag-val").textContent = v.toFixed(1);
    layer.exaggeration = v;
    if (!altPinned) {
      layer.altScale = v;
      showAlt();
    }
    map.setTerrain(v > 0 ? { source: "terrain-dem", exaggeration: v } : null);
  });

  // --- particle speed ---
  const sf = $("speed-factor");
  sf.addEventListener("input", () => {
    layer.speedFactor = Number(sf.value);
    $("speed-val").textContent = Number(sf.value).toFixed(1);
  });

  // --- wind height trim + live readouts ---
  // The terrain texture is ~1.4 km per cell while MapLibre draws the DEM at
  // ~38 m, so the two surfaces never agree exactly. This exposes the gap and
  // lets it be trimmed out by eye.
  const yo = $("y-offset");
  const yoNum = $("y-offset-num");
  const yVal = $("y-val");
  const yOut = $("y-readout");
  // Slider for sweeping, number box for landing on an exact value — the
  // slider's 50 m step is too coarse once you are close.
  const setTrim = (v, from) => {
    layer.yOffset = v;
    yVal.textContent = `${v} m`;
    if (from !== "slider") yo.value = String(Math.max(-12000, Math.min(12000, v)));
    if (from !== "number") yoNum.value = String(v);
  };
  yo.addEventListener("input", () => setTrim(Number(yo.value), "slider"));
  yoNum.addEventListener("input", () => {
    const v = Number(yoNum.value);
    if (Number.isFinite(v)) setTrim(v, "number");
  });
  let lastProbe = 0;
  layer.onProbe = (p) => {
    const now = performance.now();
    if (now - lastProbe < 250) return;   // readouts, not a firehose
    lastProbe = now;
    const f = (v) => (v == null || Number.isNaN(v) ? "—" : `${Math.round(v)} m`);
    // queryTerrainElevation returns a hard 0 in this MapLibre build even with
    // DEM tiles loaded, so it is not shown — it would read as a 1500 m
    // disagreement that does not exist.
    yOut.textContent =
      `ground ${f(p.shaderTerrain)} · camera ${f(p.cameraAlt)} · trim ${f(p.yOffset)}`;
  };

  // --- wind strength (simulation) ---
  // Multiplies the real wind so terrain effects are legible on a calm day.
  // Labelled as simulated whenever it is above 1 so it can never be mistaken
  // for the forecast.
  const wg = $("wind-gain");
  const wgVal = $("wind-val");
  const wgHint = $("wind-hint");
  wg.addEventListener("input", () => {
    const v = Number(wg.value);
    layer.windGain = v;
    if (v === 1) {
      wgVal.textContent = "forecast";
      wgHint.textContent = "Scales the real wind so terrain effects are easier to see. Not a forecast.";
      wgHint.classList.remove("sim");
    } else {
      wgVal.textContent = `${v.toFixed(1)}× simulated`;
      wgHint.textContent = `Simulated: showing ${v.toFixed(1)}× the forecast wind, not real conditions.`;
      wgHint.classList.add("sim");
    }
  });

  // --- time slider + playback ---
  const slider = $("time-slider");
  const label = $("time-label");
  const playBtn = $("play");
  const maxLead = meta.frames[meta.frames.length - 1].lead_hours;
  slider.max = String(maxLead);
  let playing = false;
  let lastTs = 0;
  const HOURS_PER_SEC = 0.7;

  function setTime(t, fromSlider = false) {
    layer.time = Math.max(0, Math.min(maxLead, t));
    if (!fromSlider) slider.value = String(Math.round(layer.time));
    const valid = new Date(init.getTime() + layer.time * 3600e3);
    const opts = { month: "short", day: "numeric", hour: "numeric" };
    label.textContent = `+${Math.round(layer.time)} h · ${valid.toLocaleString(undefined, opts)}`;
    window.dispatchEvent(new CustomEvent("windtime", { detail: layer.time }));
  }

  slider.addEventListener("input", () => {
    pause();
    setTime(Number(slider.value), true);
  });

  function tick(ts) {
    if (!playing) return;
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    let t = layer.time + dt * HOURS_PER_SEC;
    if (t > maxLead) t = 0; // loop
    setTime(t);
    requestAnimationFrame(tick);
  }
  function pause() {
    playing = false;
    playBtn.textContent = "▶";
  }
  playBtn.addEventListener("click", () => {
    playing = !playing;
    playBtn.textContent = playing ? "❚❚" : "▶";
    if (playing) {
      lastTs = 0;
      requestAnimationFrame(tick);
    }
  });

  setTime(0);
  drawLegend($("legend"));

  // --- camera elevation readout ---
  // Reads the true eye point from the transform (same source the occlusion
  // raymarch uses) plus the shader's terrain under it, so the numbers match
  // what is actually rendered.
  const camOut = $("cam-readout");
  const b = meta.bounds;
  setInterval(() => {
    try {
      const cam = map.transform.getCameraPosition();
      const alt = cam.altitude;
      if (!Number.isFinite(alt)) return;
      const nx = (cam.lngLat.lng - b.west) / (b.east - b.west);
      const ny = (b.north - cam.lngLat.lat) / (b.north - b.south);
      const ground = layer.sampleTerrain?.(nx, ny);
      const ft = Math.round(alt * 3.28084).toLocaleString();
      let txt = `camera ${Math.round(alt).toLocaleString()} m / ${ft} ft ASL`;
      if (ground != null) {
        txt += ` · ${Math.round(Math.max(0, alt - ground)).toLocaleString()} m above ground`;
      }
      camOut.textContent = txt;
    } catch { /* readout is best-effort */ }
  }, 250);

  // --- weather stack (radar / clouds / precip / sun) ---
  if (weather) {
    $("weather-controls").hidden = false;
    drawRadarLegend($("radar-legend"), dbzColor);

    const tClouds = $("toggle-clouds");
    const tPrecip = $("toggle-precip");
    const tStorms = $("toggle-storms");
    const tRadar = $("toggle-radar");
    const tSun = $("toggle-sun");
    // Force checkbox state to match the layers (browsers restore ticks across
    // reloads), including the lowmem path that starts with them off.
    tClouds.checked = weather.clouds?.enabled ?? false;
    tPrecip.checked = weather.precip?.enabled ?? false;
    tStorms.checked = weather.storms?.enabled ?? false;
    tRadar.checked = weather.radar.enabled !== false;
    tSun.checked = weather.lighting.enabled;

    tClouds.addEventListener("change", () => {
      if (weather.clouds) weather.clouds.enabled = tClouds.checked;
      map.triggerRepaint();
    });
    tStorms.addEventListener("change", () => {
      if (weather.storms) weather.storms.enabled = tStorms.checked;
      map.triggerRepaint();
    });
    tPrecip.addEventListener("change", () => {
      if (weather.precip) weather.precip.enabled = tPrecip.checked;
      if (weather.rain) weather.rain.enabled = tPrecip.checked;
      map.triggerRepaint();
    });
    tRadar.addEventListener("change", () => weather.radar.setVisible(tRadar.checked));
    tSun.addEventListener("change", () => weather.lighting.setEnabled(tSun.checked));

    const rop = $("radar-opacity");
    rop.value = String(weather.radar.opacity);
    $("radar-op-val").textContent = Number(rop.value).toFixed(2);
    rop.addEventListener("input", () => {
      weather.radar.setOpacity(Number(rop.value));
      $("radar-op-val").textContent = Number(rop.value).toFixed(2);
    });

    const cden = $("cloud-density");
    cden.addEventListener("input", () => {
      if (weather.clouds) weather.clouds.density = Number(cden.value);
      $("cloud-den-val").textContent = `${Number(cden.value).toFixed(1)}×`;
      map.triggerRepaint();
    });

    const pfall = $("precip-fall");
    pfall.addEventListener("input", () => {
      if (weather.precip) weather.precip.fallGain = Number(pfall.value);
      $("precip-fall-val").textContent = `${pfall.value}×`;
    });

    // small sun readout under the toggle: elevation + local phase
    const sunOut = $("sun-readout");
    const phase = (el) => el > 10 ? "day" : el > 0 ? "golden hour"
      : el > -6 ? "civil twilight" : el > -12 ? "twilight" : "night";
    setInterval(() => {
      const s = weather.lighting.state;
      if (s?.elevationDeg == null) return;
      sunOut.textContent =
        `sun ${s.elevationDeg >= 0 ? "+" : ""}${s.elevationDeg.toFixed(0)}° · ${phase(s.elevationDeg)}`;
    }, 1000);
  }
}
