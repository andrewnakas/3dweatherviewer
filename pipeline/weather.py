"""Build the per-lead weather atlas: precip, radar, clouds, surface, condensate.

Runs inside the same per-lead worker as the wind frame, and returns an
ALREADY-QUANTIZED uint8 atlas — the encodings are fixed absolute scales
(config.WX_ENC), so no cross-frame min/max pass (and no second float stack in
RAM) is needed. See config.py for the tile/channel map and NaN semantics.
"""

import numpy as np

from config import TILE_H, TILE_W, WX_CONDENSATE_LEVELS, WX_ENC, WX_TILES
from encode import encode_wx_tile, new_wx_atlas, quantize, wx_tile_slice
from reproject import regrid

# Surface-group variables read per lead (beyond pressure_surface, which the
# wind mask already reads and passes in).
SFC_VARS = [
    "precipitation_rate_surface",
    "percent_frozen_precipitation_surface",
    "categorical_freezing_rain_surface",
    "categorical_ice_pellets_surface",
    "composite_reflectivity",
    "echo_top",
    "vertically_integrated_liquid_atmosphere",
    "total_cloud_cover_atmosphere",
    "geopotential_height_cloud_base",
    "geopotential_height_cloud_top",
    "low_cloud_cover",
    "medium_cloud_cover",
    "high_cloud_cover",
    "temperature_2m",
    "dew_point_temperature_2m",
    "downward_short_wave_radiation_flux_surface",
    "wind_gust_surface",
    "visibility_surface",
    "snow_thickness_surface",
    # Simulated GOES brightness temperatures: 113/123 = GOES-West/East water
    # vapor channel, 114/124 = GOES-West/East IR window channel.
    "brightness_temperature_channel_113",
    "brightness_temperature_channel_114",
    "brightness_temperature_channel_123",
    "brightness_temperature_channel_124",
]


def build_wx_frame(sfc_t, prs_t, index_map, psfc):
    """Weather atlas for one lead hour.

    sfc_t/prs_t: the surface / pressure-level datasets already selected to
    (init_time, lead); index_map: from reproject.build_index_map;
    psfc: surface pressure (Pa) already regridded for the wind mask.
    Returns (WX_ATLAS_H, WX_ATLAS_W, 4) uint8.
    """
    atlas = new_wx_atlas()
    domain = index_map["valid"]

    def rg(name):
        return regrid(sfc_t[name].values, index_map)

    # --- precip: rate (mm/h), frozen fraction, freezing bucket flag ----------
    rate = rg("precipitation_rate_surface") * 3600.0  # kg m-2 s-1 -> mm/h
    frozen = np.clip(rg("percent_frozen_precipitation_surface"), 0.0, 100.0)
    # The two freezing categoricals are 0/1 flags; bilinear regrid makes them
    # fractional at edges, which the shader thresholds at 0.5.
    freezing = np.clip(
        rg("categorical_freezing_rain_surface") + rg("categorical_ice_pellets_surface"),
        0.0, 1.0,
    )
    encode_wx_tile(
        atlas, WX_TILES["precip"],
        quantize(rate, WX_ENC["precipRate"]),
        quantize(frozen, WX_ENC["frozenFrac"]),
        quantize(freezing, WX_ENC["freezingFlag"]),
        domain,
    )

    # --- radar: composite reflectivity, echo top, VIL ------------------------
    encode_wx_tile(
        atlas, WX_TILES["radar"],
        quantize(rg("composite_reflectivity"), WX_ENC["reflectivity"]),
        quantize(rg("echo_top"), WX_ENC["echoTop"]),
        quantize(rg("vertically_integrated_liquid_atmosphere"), WX_ENC["vil"]),
        domain,
    )

    # --- cloud: total cover, base, top (base/top NaN -> byte 0 sentinel) -----
    encode_wx_tile(
        atlas, WX_TILES["cloud"],
        quantize(rg("total_cloud_cover_atmosphere"), WX_ENC["cloudCover"]),
        quantize(rg("geopotential_height_cloud_base"), WX_ENC["cloudBase"]),
        quantize(rg("geopotential_height_cloud_top"), WX_ENC["cloudTop"]),
        domain,
    )

    encode_wx_tile(
        atlas, WX_TILES["cloudLayers"],
        quantize(rg("low_cloud_cover"), WX_ENC["cloudCover"]),
        quantize(rg("medium_cloud_cover"), WX_ENC["cloudCover"]),
        quantize(rg("high_cloud_cover"), WX_ENC["cloudCover"]),
        domain,
    )

    t2m = rg("temperature_2m")  # degC; reused for the satellite cloud-top estimate
    encode_wx_tile(
        atlas, WX_TILES["surface"],
        quantize(t2m, WX_ENC["t2m"]),
        quantize(rg("dew_point_temperature_2m"), WX_ENC["td2m"]),
        quantize(rg("downward_short_wave_radiation_flux_surface"), WX_ENC["dswrf"]),
        domain,
    )

    # --- satellite: simulated GOES IR/WV composite + BT-derived cloud top ----
    # Coldest-view composite of the East/West satellites. Cloud-top height
    # above ground from the IR window BT via a standard 6.5 K/km lapse against
    # the 2 m temperature — crude next to a real retrieval, but plenty to
    # place cloud tops for rendering. Warmer than (t2m - 4 K) counts as clear
    # sky and takes the byte-0 sentinel.
    bt_ir = np.minimum(
        rg("brightness_temperature_channel_114"),
        rg("brightness_temperature_channel_124"),
    )
    bt_wv = np.minimum(
        rg("brightness_temperature_channel_113"),
        rg("brightness_temperature_channel_123"),
    )
    with np.errstate(invalid="ignore"):
        t2k = t2m + 273.15
        top_agl = np.clip((t2k - bt_ir) / 0.0065, 0.0, 16000.0)
        sat_top = np.where(bt_ir <= t2k - 4.0, top_agl, np.nan)
    encode_wx_tile(
        atlas, WX_TILES["satellite"],
        quantize(bt_ir, WX_ENC["irBT"]),
        quantize(sat_top, WX_ENC["satTop"]),
        quantize(bt_wv, WX_ENC["wvBT"]),
        domain,
    )

    encode_wx_tile(
        atlas, WX_TILES["surface2"],
        quantize(rg("wind_gust_surface"), WX_ENC["gust"]),
        quantize(rg("visibility_surface"), WX_ENC["visibility"]),
        quantize(rg("snow_thickness_surface"), WX_ENC["snowDepth"]),
        domain,
    )

    # --- condensate column: 12 pressure levels of qc / qp / RH ----------------
    # Read one variable at a time over just the subset levels (each slab is
    # (y, x, 12) float, ~90 MB) and free it immediately — never two 39-level
    # slabs alive at once. Accumulate in the native grid, regrid per level.
    sel = {"pressure_level": WX_CONDENSATE_LEVELS}

    def read(name):
        return np.nan_to_num(prs_t[name].sel(**sel).values, nan=0.0)

    qc = read("cloud_mixing_ratio")
    qc += read("cloud_ice_mixing_ratio")
    qp = read("rain_mixing_ratio")
    qp += read("snow_mixing_ratio")
    qp += read("graupel")
    rh = prs_t["relative_humidity"].sel(**sel).values

    psfc_ok = np.nan_to_num(psfc, nan=0.0)
    for i, p in enumerate(WX_CONDENSATE_LEVELS):
        above_ground = domain & (p * 100.0 <= psfc_ok)
        encode_wx_tile(
            atlas, WX_TILES["condensate0"] + i,
            quantize(regrid(qc[:, :, i], index_map), WX_ENC["qc"]),
            quantize(regrid(qp[:, :, i], index_map), WX_ENC["qp"]),
            quantize(regrid(rh[:, :, i], index_map), WX_ENC["rh"]),
            above_ground,
        )
    del qc, qp, rh

    # Sanity check mirroring the wind frame's: t2m must exist at domain center.
    tile = wx_tile_slice(atlas, WX_TILES["surface"])
    if tile[TILE_H // 2, TILE_W // 2, 3] == 0:
        raise ValueError("weather atlas: no valid t2m at domain center")

    return atlas
