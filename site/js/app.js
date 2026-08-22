// Bootstrap: map + terrain + wind layer + UI.

import { WindLayer } from "./windLayer.js";
import { initUI } from "./ui.js";
import { PointCast } from "./pointcast.js";

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

    const layer = new WindLayer(map, meta, {
      exaggeration: 1,
      terrainPhysics: new URLSearchParams(location.search).get("tp") !== "0",
      onReady: () => {
        initUI(map, layer, meta);
        new PointCast(map, layer, meta);
      },
    });
    window.__windLayer = layer; // debugging hook
    if (isMobile) layer.particleCount = 65536;
    if (sessionStorage.getItem("lowmem")) layer.particleCount = 16384;
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
