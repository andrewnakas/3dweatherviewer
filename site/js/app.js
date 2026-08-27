// Bootstrap: map + terrain + wind/precip/cloud layers + radar + sun + UI.

import { WindLayer } from "./windLayer.js";
import { initUI } from "./ui.js";
import { PointCast } from "./pointcast.js";
import { CpuAtlas } from "./cpuAtlas.js";
import { RadarOverlay } from "./radarOverlay.js";
import { Lighting } from "./lighting.js";
import { PrecipLayer } from "./precipLayer.js";
import { CloudLayer } from "./cloudLayer.js";
import { StormLayer } from "./stormLayer.js";
import { FireLayer } from "./fireLayer.js";
import { FrameManager } from "./frames.js";
import { AGL_LADDER_FULL, fullColumnIndices } from "./atmosphere.js";

// The `?c=1` is deliberate. S3 only attaches Access-Control-Allow-Origin when
// the request carries an Origin header, so a cached non-CORS copy of the same
// URL — fetched earlier by anything else — gets reused for the CORS request and
// Safari blocks it ("Fetch API cannot load ... due to access control checks"),
// leaving the map with no terrain at all. A distinct query string keeps the DEM
// in its own cache entry that is only ever populated by a CORS request.
const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png?c=1";
const IMAGERY_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const LABEL_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";

function fail(msg) {
  const el = document.getElementById("error");
  el.textContent = msg;
  el.hidden = false;
}

async function main() {
  let meta;
  try {
    const r = await fetch(`data/meta.json?t=${Date.now()}`); // always-fresh meta
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    meta = await r.json();
  } catch (e) {
    fail("Wind data not available yet (data/meta.json missing). " +
      "The GitHub Action may still be running its first build.");
    throw e;
  }

  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || window.innerWidth < 700;
  let map;
  try {
    map = new maplibregl.Map({
      container: "map",
      style: {
        version: 8,
        sources: {
          imagery: {
            type: "raster",
            tiles: [IMAGERY_TILES],
            tileSize: 256,
            maxzoom: 18,
            attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
          },
          labels: {
            type: "raster",
            tiles: [LABEL_TILES],
            tileSize: 256,
            maxzoom: 18,
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { "background-color": "#0b0e14" } },
          { id: "imagery", type: "raster", source: "imagery" },
          { id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.85 } },
        ],
      },
      center: [-111.04, 45.68], // Bozeman, MT
      zoom: isMobile ? 8.8 : 9.6,
      pitch: 65,
      bearing: -15,
      maxPitch: 80,
      antialias: !isMobile, // MSAA is heavy on mobile GPUs
    });
  } catch (e) {
    fail(`Couldn't start the map (WebGL2 unavailable?): ${e.message}`);
    throw e;
  }
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserLocation: true,
      fitBoundsOptions: { maxZoom: 10, pitch: 65 },
    }),
    "top-right"
  );
  window.__map = map; // debugging hook

  map.on("load", () => {
    map.addSource("terrain-dem", {
      type: "raster-dem",
      tiles: [TERRAIN_TILES],
      tileSize: 256,
      maxzoom: 12,
      encoding: "terrarium",
      attribution: "Terrain: AWS Terrain Tiles / Mapzen",
    });
    map.setTerrain({ source: "terrain-dem", exaggeration: 1 });

    const lowmem = !!sessionStorage.getItem("lowmem");

    // Weather stack (radar / sun / precip / clouds) — only when the data
    // build carries a weather atlas, so the site still works against a
    // wind-only build.
    let weather = null;
    if (meta.weather?.frames?.length) {
      const wxCpu = new CpuAtlas({
        frames: meta.weather.frames, atlas: meta.weather.atlas,
        tile: meta.weather.tile, initTime: meta.init_time,
      });
      // One GPU FrameManager for the weather PNGs, shared by precip + clouds
      // (custom layers share the map's GL context).
      const wxShared = {
        fm: null,
        get(gl) {
          this.fm ??= new FrameManager(gl, {
            init_time: meta.init_time, frames: meta.weather.frames,
          });
          return this.fm;
        },
      };
      weather = {
        wxCpu,
        wxShared,
        lighting: new Lighting(map, meta, wxCpu),
        radar: new RadarOverlay(map, meta, wxCpu),
      };
      // Precipitating areas render as dark rain clouds by default; the dBZ
      // imagery (drape + towers) is opt-in via the panel.
      weather.radar.enabled = false;
    }

    const layer = new WindLayer(map, meta, {
      exaggeration: 1,
      terrainPhysics: new URLSearchParams(location.search).get("tp") !== "0",
      // The weather viewer defaults to the full 3D column: winds at every
      // altitude from the surface to the jet stream, drawn at true heights.
      // Half the rungs sit in the lowest 400 m, so the terrain-flow physics
      // (draping, updrafts, lee wakes) stays visible underneath the upper
      // winds. The surface-skin and boundary-layer modes remain as toggles.
      groundHug: false,
      aglLadder: AGL_LADDER_FULL,
      onReady: () => {
        layer.fullColumn = true;
        layer.setLevels(fullColumnIndices(meta));
        if (weather) {
          weather.storms = new StormLayer(map, meta, layer, weather.lighting,
            weather.wxShared, { grid: isMobile ? 64 : 96, enabled: false });
          // rainfall curtains: how forecast precip reads at map scales,
          // on by default and toggled together with the rain particles
          weather.rain = new StormLayer(map, meta, layer, weather.lighting,
            weather.wxShared, { grid: isMobile ? 64 : 96, variant: "rain" });
          weather.precip = new PrecipLayer(map, meta, layer, weather.lighting,
            weather.wxShared, { particleCount: isMobile ? 16384 : 65536 });
          weather.clouds = new CloudLayer(map, meta, layer, weather.lighting,
            weather.wxShared, { grid: isMobile ? 44 : 72 });
          // HRRR-Smoke plumes: same billboard machinery, SMOKE variant
          weather.smoke = new CloudLayer(map, meta, layer, weather.lighting,
            weather.wxShared, { grid: isMobile ? 44 : 72, variant: "smoke", layers: 4 });
          weather.fires = new FireLayer(map, meta, layer);
          if (lowmem) {
            weather.precip.enabled = false;
            weather.clouds.enabled = false;
            weather.storms.enabled = false;
            weather.rain.enabled = false;
            weather.smoke.enabled = false;
          }
          try {
            map.addLayer(weather.storms);
            map.addLayer(weather.rain);
            map.addLayer(weather.precip);
            map.addLayer(weather.smoke);
            map.addLayer(weather.clouds);
            map.addLayer(weather.fires);
          } catch (e) {
            console.warn("weather layers unavailable:", e.message);
          }
          weather.radar.setTime(0); // first paint before any slider move
          // FIRMS hotspots: a snapshot next to the forecast, not a live feed
          if (meta.fires?.file) {
            fetch(`data/${meta.fires.file}?v=${encodeURIComponent(meta.init_time)}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => { if (d?.fires?.length) weather.fires.setFires(d.fires); })
              .catch((e) => console.warn("fire hotspots unavailable:", e.message));
          }
          window.__weather = weather; // debugging hook
        }
        initUI(map, layer, meta, weather);
        new PointCast(map, layer, meta, weather?.wxCpu);
      },
    });
    window.__windLayer = layer; // debugging hook
    if (isMobile) layer.particleCount = 65536;
    if (lowmem) layer.particleCount = 16384;
    try {
      map.addLayer(layer);
    } catch (e) {
      fail(`This browser can't run the wind layer: ${e.message}`);
      throw e;
    }
  });

  map.on("error", (e) => console.warn("map error:", e?.error?.message ?? e));
  map.getCanvas().addEventListener("webglcontextlost", () => {
    fail("Graphics memory ran out — reloading with lighter settings…");
    sessionStorage.setItem("lowmem", "1");
    setTimeout(() => location.reload(), 1500);
  });
}

main();
