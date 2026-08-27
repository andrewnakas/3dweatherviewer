"""Single source of truth for the data pipeline.

The contract between pipeline and frontend is meta.json + the atlas PNG
layout defined here. Change tile size / level list here only.
"""

DATASET_ID = "noaa-hrrr-forecast-48-hour-virtual"

# HRRR pressure levels in the dataset, ordered surface -> top (hPa).
PRESSURE_LEVELS = [
    1000, 975, 950, 925, 900, 875, 850, 825, 800, 775,
    750, 725, 700, 675, 650, 625, 600, 575, 550, 525,
    500, 475, 450, 425, 400, 375, 350, 325, 300, 275,
    250, 225, 200, 175, 150, 125, 100, 75, 50,
]

# Atlas tile order: index 0 = 10m, 1 = 80m, then pressure levels surface->top.
# Each entry: (id, kind, value)
LEVELS = [("10m", "height_agl", 10), ("80m", "height_agl", 80)] + [
    (str(p), "pressure", p) for p in PRESSURE_LEVELS
]  # 41 levels total

# Target regular lat/lon grid (covers the HRRR LCC domain; cells outside the
# native grid get alpha=0 in the atlas). Bounds chosen from the dataset's
# 2D latitude/longitude coords, rounded outward slightly.
WEST, EAST = -134.1, -60.9
SOUTH, NORTH = 21.1, 52.7
TILE_W, TILE_H = 450, 265  # lon x lat samples per level tile (~12 km effective)

ATLAS_COLS, ATLAS_ROWS = 7, 6  # 42 slots: 41 levels + terrain tile
TERRAIN_TILE_INDEX = 41  # surface elevation, 16-bit packed in R/G
ATLAS_W = ATLAS_COLS * TILE_W   # 3150
ATLAS_H = ATLAS_ROWS * TILE_H   # 1590
assert len(LEVELS) < ATLAS_COLS * ATLAS_ROWS, "no free slot left for the terrain tile"
assert TERRAIN_TILE_INDEX >= len(LEVELS), "terrain tile would overwrite a level"
assert ATLAS_W <= 4096 and ATLAS_H <= 4096, "atlas exceeds safe WebGL texture size"

# Standalone high-resolution terrain texture (its own PNG, not an atlas tile).
# The wind atlas is deliberately coarse — 12.8 km cells are plenty for a
# smooth wind field — but terrain physics reads the SLOPE of the ground, and
# it has to place particles on the same surface MapLibre draws. Both demand
# far more resolution than the atlas, hence a separate texture at the largest
# size that is still safe to upload (~1.4 km cells).
TERRAIN_HI_W, TERRAIN_HI_H = 4096, 2560
assert TERRAIN_HI_W <= 4096 and TERRAIN_HI_H <= 4096, "terrain exceeds safe texture size"

# Curvature length scale (eta): roughly half the wavelength of the terrain
# features that should drive ridge speed-up. ~2 cells of the hi-res grid.
CURV_LENGTH_M = 2800.0

# HRRR native grid / projection (verified against the dataset's spatial_ref).
LCC_PROJ = (
    "+proj=lcc +lat_1=38.5 +lat_2=38.5 +lat_0=38.5 +lon_0=-97.5 "
    "+x_0=0 +y_0=0 +R=6371229 +units=m +no_defs"
)
REF_LON = -97.5
ROTCON = 0.6225146  # sin(38.5 deg): grid->earth wind rotation constant

# --- Weather atlas -----------------------------------------------------------
#
# A second, smaller per-lead atlas (frames/wNN.png) carrying the non-wind
# weather: precip, radar, clouds, surface conditions, and a 12-level condensate
# column. Same tile size and grid as the wind atlas so one index map serves
# both. Unlike the wind atlas, every channel uses a FIXED absolute scale
# (WX_ENC below, mirrored into meta.json): colors stay stable across cycles
# and quantization can happen inside the per-lead worker, so no second
# full-stack float copy ever exists in RAM.
#
# NaN semantics: the A channel is purely "inside domain (and, for condensate
# tiles, level above ground)". Fields that can be absent inside the domain
# (no cloud, no echo) reserve byte 0 as the "none" sentinel and quantize real
# values to 1..255 — regrid()'s NaN-means-outside-domain convention never
# collides with NaN-means-no-cloud.
WX_ATLAS_COLS, WX_ATLAS_ROWS = 7, 3
WX_ATLAS_W = WX_ATLAS_COLS * TILE_W   # 3150
WX_ATLAS_H = WX_ATLAS_ROWS * TILE_H   # 795
assert WX_ATLAS_W <= 4096 and WX_ATLAS_H <= 4096, "weather atlas exceeds safe texture size"

# Pressure levels carried in the condensate tiles (subset: enough vertical
# structure for clouds without shipping all 39 levels).
WX_CONDENSATE_LEVELS = [1000, 950, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200]

WX_TILES = {
    "precip": 0,       # R rate, G frozen %, B freezing flag
    "radar": 1,        # R composite dBZ, G echo top, B VIL
    "cloud": 2,        # R total cover, G cloud base, B cloud top
    "cloudLayers": 3,  # R low, G medium, B high cover
    "surface": 4,      # R t2m, G td2m, B DSWRF
    "surface2": 5,     # R gust, G visibility, B snow depth
    "condensate0": 6,  # 12 tiles: R cloud qc+qi, G precip qr+qs+qg, B RH
    "satellite": 18,   # R IR-window BT, G BT-derived cloud top AGL, B WV BT
    "smoke": 19,       # R column smoke, G near-surface smoke, B aerosol depth
}
assert WX_TILES["condensate0"] + len(WX_CONDENSATE_LEVELS) <= WX_TILES["satellite"]
assert max(WX_TILES.values()) < WX_ATLAS_COLS * WX_ATLAS_ROWS

# Channel encodings, the single source of truth (mirrored into meta.json).
# kind: linear (min..max), sqrt (sqrt(v/max), v clipped >= 0), log10
# (log10(v+1)/div). zeroIsNone: byte 0 = absent, data in 1..255.
WX_ENC = {
    "precipRate":   {"kind": "sqrt", "max": 128.0},          # mm/h
    "frozenFrac":   {"kind": "linear", "min": 0, "max": 100},  # %
    "freezingFlag": {"kind": "linear", "min": 0, "max": 1},
    "reflectivity": {"kind": "linear", "min": -10, "max": 75, "zeroIsNone": True},  # dBZ
    "echoTop":      {"kind": "linear", "min": 0, "max": 20000, "zeroIsNone": True},  # m
    "vil":          {"kind": "sqrt", "max": 80.0},           # kg/m^2
    "cloudCover":   {"kind": "linear", "min": 0, "max": 100},  # %
    # Height fields sampled with BILINEAR filtering in the shaders must NOT
    # use the byte-0 absence sentinel: filtering across a cloudy/clear edge
    # dragged decoded bases toward zero and dropped whole cloud fields onto
    # the terrain. Cloudless cells are instead infilled with the nearest
    # valid height (weather.infill_nearest) — cloud EXISTENCE is gated by the
    # cover channel, so the height only needs to be smooth and plausible.
    "cloudBase":    {"kind": "linear", "min": 0, "max": 16000},  # m ASL
    "cloudTop":     {"kind": "linear", "min": 0, "max": 16000},  # m ASL
    "t2m":          {"kind": "linear", "min": -60, "max": 50},   # degC
    "td2m":         {"kind": "linear", "min": -60, "max": 50},   # degC
    "dswrf":        {"kind": "linear", "min": 0, "max": 1250},   # W/m^2
    "gust":         {"kind": "linear", "min": 0, "max": 60},     # m/s
    "visibility":   {"kind": "log10", "div": 5.0},               # m
    "snowDepth":    {"kind": "sqrt", "max": 5.0},                # m
    "qc":           {"kind": "sqrt", "max": 3.0e-3},             # kg/kg cloud+ice
    "qp":           {"kind": "sqrt", "max": 5.0e-3},             # kg/kg rain+snow+graupel
    "rh":           {"kind": "linear", "min": 0, "max": 100},    # %
    "irBT":         {"kind": "linear", "min": 180, "max": 330},  # K, IR window
    "satTop":       {"kind": "linear", "min": 0, "max": 16000},  # m AGL, infilled
    "wvBT":         {"kind": "linear", "min": 180, "max": 280},  # K, water vapor
    # HRRR-Smoke. Maxes are set from the observed range of a real run
    # (column p99 4.3e-5, max 5.0e-4 kg/m2; near-surface p99 1.2e-8,
    # max 2.0e-6 kg/m3), with sqrt encoding so thin haze keeps resolution.
    "smokeCol":     {"kind": "sqrt", "max": 5.0e-4},   # kg/m2 column smoke
    "smokeSfc":     {"kind": "sqrt", "max": 2.0e-6},   # kg/m3 near-surface
    "aod":          {"kind": "linear", "min": 0, "max": 3},  # aerosol optical depth
}

LEAD_HOURS = list(range(49))  # 0..48

# Quantization: per-level min/max over all frames, padded by this fraction.
SCALE_PAD = 0.05


def height_meters(level_id: str, kind: str, value: float) -> float:
    """Approximate geometric altitude for a level (standard atmosphere for
    pressure levels; AGL height used directly for 10m/80m)."""
    if kind == "height_agl":
        return float(value)
    return round(44330.0 * (1.0 - (value / 1013.25) ** 0.1903), 0)
