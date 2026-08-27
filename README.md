# 3D Weather Viewer

Browser-based 3D visualization of the full NOAA HRRR CONUS forecast — **wind, precipitation, clouds, radar, and the sun** fused into one 3D scene over real terrain, with an hourly-updating 0–18 h forecast time slider.

An expansion of [3dWindViewer](https://github.com/andrewnakas/3dWindViewer): the wind system (GPU particle advection at 41 vertical levels with terrain-flow physics) carries over unchanged, and everything else about the weather joins it.

## What it shows

- **Wind** — GPU particle animation at 41 vertical levels (10 m, 80 m, and all 39 pressure levels) with terrain-flow physics; see the 3dWindViewer README for the full story.
- **Precipitation** — rain and snow fall through the scene as 3D particles: spawned under the model's cloud base, advected by the low-level wind on the way down, density driven by the local precipitation rate, phase (rain streaks vs fluttering snow, freezing rain tinted) from HRRR's precipitation-type fields.
- **Radar** — composite reflectivity draped over the terrain in the familiar dBZ colors.
- **Clouds** — lit billboard cloud puffs placed between the model's cloud base and top, dense where cloud cover and pressure-level condensate say clouds actually are.
- **Sun** — astronomically computed sun position for the forecast valid time drives the sky color, day/night ground lighting, and the lighting on clouds and precipitation. The viewer opens at **now**, not at the forecast init hour, so the light on screen matches the sky outside; scrub the slider and watch it change.
- **Smoke and fire** — HRRR-Smoke mass density on 12 native model levels rendered as a true volume (stacked sample planes with sun-direction self-shadowing), plus NASA FIRMS VIIRS hotspots from the last 24 h as glowing fires sized by radiative power.
- **Conditions** — click anywhere for the local wind profile plus 2 m temperature/dewpoint, humidity, precipitation rate and type, cloud cover and base, gusts, and visibility.

## How it works

```
dynamical.org noaa-hrrr-forecast-18-hour-virtual (hourly inits, all levels)
        │  GitHub Actions, every hour (Python)
        ▼
reproject LCC → lat/lon · downsample to ~12 km · rotate winds grid→earth
        ▼
19 wind atlases (u/v/omega per level)  +  19 weather atlases
(precip rate/type, reflectivity, cloud cover/base/top, t2m/dewpoint,
 solar flux, 12 levels of cloud & precip condensate,
 12 native levels of 3D smoke)  +  terrain.png  +  fires.json (NASA FIRMS)
        │  deployed with the static site as one GitHub Pages artifact
        ▼
MapLibre GL JS + custom WebGL2 layers: wind particles, falling precip,
billboard clouds, draped radar, sun-driven sky & lighting
```

- **Data**: [NOAA HRRR via dynamical.org](https://dynamical.org/catalog/noaa-hrrr-forecast-18-hour-virtual/) — the hourly-init "virtual" dataset (0–18 h), so the freshest run is at most ~1–2 h old. Read with `dynamical-catalog` + xarray in `pipeline/`.
- **No data in git**: `site/data/` exists only inside the Pages deployment artifact; a failed build leaves the previous forecast live.
- **Wind atlas** (`frames/fNN.png`): 41 level tiles, u/v in R/G, omega in B, per-level scaling in `meta.json` — identical to 3dWindViewer.
- **Weather atlas** (`frames/wNN.png`): 18 tiles of surface + column weather on the same grid, fixed absolute scales (documented in `meta.json` `weather.enc`). Inside the domain, byte 0 means "no cloud / no echo" for the fields that need it.
- **Sun**: NOAA solar-position math computed client-side (`site/js/sun.js`) — no data needed, exact for the valid time under the slider.
- **Terrain**: AWS Terrain Tiles (terrarium encoding); Esri World Imagery basemap.

## Local development

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt

# build a few test frames (~3 min)
PYTHONPATH=pipeline .venv/bin/python pipeline/build_frames.py --out site/data --leads "0 3 6" --workers 3

python3 -m http.server 8931 -d site   # open http://localhost:8931
```

`?debug` overlays the raw atlas image for georeference checks.

## Deploy / operations

- `.github/workflows/build-and-deploy.yml` runs hourly at :35 UTC, on push to main (quick 3-lead build), and manually via *Run workflow* (optional lead-hours subset and worker count).
- First-time setup: repo Settings → Pages → Source: **GitHub Actions**.

## Related projects

- [3dWindViewer](https://github.com/andrewnakas/3dWindViewer) — the wind system this expands
- [Leaflet_3d_terrain_maps](https://github.com/andrewnakas/Leaflet_3d_terrain_maps) — the 3D terrain approach
- [windplayground-](https://github.com/andrewnakas/windplayground-) — wind forecast modeling experiments

## License

MIT
