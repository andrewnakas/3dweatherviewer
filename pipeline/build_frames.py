"""Build web-ready wind frames from the dynamical.org virtual HRRR dataset.

Usage:
  python pipeline/build_frames.py --out site/data [--leads "0 6 12"] [--workers 4]
"""

import argparse
import logging
import os
import resource
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np

from config import (
    LEAD_HOURS, LEVELS, PRESSURE_LEVELS, TILE_H, TILE_W,
    WX_CONDENSATE_LEVELS, height_meters,
)
from encode import compute_scales, write_output, wx_meta_block
from hrrr_source import open_datasets, pick_init
from reproject import build_index_map, regrid, rotate_winds
from terrain import build_terrain_fields, write_terrain_png
from weather import build_wx_frame

log = logging.getLogger("build_frames")

SFC_VARS = [("wind_u_10m", "wind_v_10m"), ("wind_u_80m", "wind_v_80m")]

# Set TERRAIN_FALLBACK_OK=1 to publish without the hi-res terrain texture (the
# terrain physics then runs on the coarse atlas tile). Off by default so a
# broken terrain build fails loudly instead of quietly shipping degraded.
ALLOW_TERRAIN_FALLBACK = os.environ.get("TERRAIN_FALLBACK_OK") == "1"


def build_frame(sfc, prs, init, lead, index_map, attempts=3):
    """Read + regrid + rotate all levels for one lead hour.

    Returns (frame, valid, wx): (nlev, TILE_H, TILE_W, 3) float16 [u, v, omega],
    a (nlev, TILE_H, TILE_W) above-ground/in-domain mask, and the quantized
    uint8 weather atlas (see weather.py).
    """
    last_err = None
    for attempt in range(attempts):
        try:
            return _build_frame(sfc, prs, init, lead, index_map)
        except Exception as e:  # noqa: BLE001 - network reads; retry then fail
            last_err = e
            log.warning("lead %d attempt %d failed: %s", lead, attempt + 1, e)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"lead {lead} failed after {attempts} attempts") from last_err


def _build_frame(sfc, prs, init, lead, index_map):
    nlev = len(LEVELS)
    frame = np.zeros((nlev, TILE_H, TILE_W, 3), dtype=np.float16)
    valid = np.zeros((nlev, TILE_H, TILE_W), dtype=bool)
    domain = index_map["valid"]

    sfc_t = sfc.sel(init_time=init).isel(lead_time=lead)
    psfc = regrid(sfc_t["pressure_surface"].values, index_map)  # Pa

    for i, (uname, vname) in enumerate(SFC_VARS):
        u = regrid(sfc_t[uname].values, index_map)
        v = regrid(sfc_t[vname].values, index_map)
        frame[i, :, :, 0], frame[i, :, :, 1] = rotate_winds(u, v, index_map)
        valid[i] = domain  # AGL levels are above ground by definition

    prs_t = prs.sel(init_time=init).isel(lead_time=lead)
    u_slab = prs_t.wind_u.values  # (y, x, nplev)
    v_slab = prs_t.wind_v.values
    w_slab = prs_t.vertical_velocity.values  # omega, Pa/s
    plev_axis = list(prs.pressure_level.values)
    for j, p in enumerate(PRESSURE_LEVELS):
        k = plev_axis.index(p)
        u = regrid(u_slab[:, :, k], index_map)
        v = regrid(v_slab[:, :, k], index_map)
        idx = 2 + j
        frame[idx, :, :, 0], frame[idx, :, :, 1] = rotate_winds(u, v, index_map)
        frame[idx, :, :, 2] = regrid(w_slab[:, :, k], index_map)
        # level is above ground where its pressure is below surface pressure
        valid[idx] = domain & (p * 100.0 <= np.nan_to_num(psfc, nan=0.0))

    if np.isnan(frame[:, TILE_H // 2, TILE_W // 2, :2]).any():
        raise ValueError(f"lead {lead}: NaN wind at domain center")

    # Weather atlas rides in the same worker pass, reusing this lead's psfc.
    # Quantized to uint8 here (fixed scales) so 49 leads cost ~230 MB total.
    wx = build_wx_frame(sfc_t, prs_t, index_map, psfc)
    return frame, valid, wx


def read_heights(prs, init):
    """Domain-mean geopotential height per level (m ASL), read once at lead 0.
    Falls back to standard atmosphere per level on failure."""
    out = [10.0, 80.0]
    try:
        gh = prs.sel(init_time=init).isel(lead_time=0).geopotential_height.values
        plev_axis = list(prs.pressure_level.values)
        for p in PRESSURE_LEVELS:
            out.append(float(np.nanmean(gh[:, :, plev_axis.index(p)])))
    except Exception as e:  # noqa: BLE001
        log.warning("geopotential height read failed (%s); using std atmosphere", e)
        out = [height_meters(lid, kind, value) for lid, kind, value in LEVELS]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--leads", default="", help='e.g. "0 1 2"; default all 0-48')
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--init", default="auto", help="auto or ISO time")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    leads = [int(x) for x in args.leads.split()] if args.leads.strip() else LEAD_HOURS

    t0 = time.time()
    sfc, prs = open_datasets()
    init = pick_init(prs, args.init, sfc=sfc)
    init_iso = np.datetime_as_string(init, unit="s") + "Z"
    log.info("init=%s leads=%s", init_iso, leads)

    index_map = build_index_map(prs.x.values, prs.y.values)
    heights = read_heights(prs, init)

    orography = sfc.sel(init_time=init).isel(lead_time=0).geopotential_height_surface.values
    # The atlas tile is ~4x coarser than native, so area-average first — point
    # sampling would hit or miss ridge crests depending on lattice alignment.
    terrain = regrid(orography, index_map, presmooth=4)

    terrain_hi_meta = None
    try:
        # write_output creates this later, but the terrain texture is written
        # first and a clean checkout has no site/data yet.
        Path(args.out).mkdir(parents=True, exist_ok=True)
        elev, curv, valid_hi, curv_max = build_terrain_fields(
            orography, prs.x.values, prs.y.values
        )
        terrain_hi_meta = write_terrain_png(
            Path(args.out) / "terrain.png", elev, curv, valid_hi
        )
        terrain_hi_meta["file"] = "terrain.png"
        log.info(
            "hi-res terrain %dx%d, elev %.0f..%.0f m, curv max %.2e 1/m",
            terrain_hi_meta["width"], terrain_hi_meta["height"],
            terrain_hi_meta["hMin"], terrain_hi_meta["hMax"], curv_max,
        )
    except Exception:  # noqa: BLE001
        # Only a DEM fetch problem is worth degrading for — anything else is a
        # bug, and swallowing it ships a build that looks green while silently
        # dropping the terrain physics, which is how this shipped broken once.
        log.exception("hi-res terrain build failed; frontend will use the atlas tile")
        if not ALLOW_TERRAIN_FALLBACK:
            raise

    frames_by_lead = {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(build_frame, sfc, prs, init, t, index_map): t for t in leads}
        for fut in as_completed(futs):
            lead = futs[fut]
            frames_by_lead[lead] = fut.result()
            # ru_maxrss is KiB on Linux; the CI runner has 16 GB and this build
            # runs close to it, so keep the watermark visible in every log.
            rss_gb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576
            log.info("lead %02d done (%d/%d), peak RSS %.1f GB",
                     lead, len(frames_by_lead), len(leads), rss_gb)

    scales = compute_scales([f for f, _, _ in frames_by_lead.values()])
    heights_by_plev = {
        p: heights[2 + PRESSURE_LEVELS.index(p)] for p in WX_CONDENSATE_LEVELS
    }
    meta = write_output(
        args.out, frames_by_lead, scales, init_iso, heights, terrain,
        terrain_hi_meta, weather=wx_meta_block(heights_by_plev),
    )

    log.info(
        "wrote %d frames to %s in %.1f min (init %s)",
        len(meta["frames"]), args.out, (time.time() - t0) / 60, init_iso,
    )


if __name__ == "__main__":
    sys.exit(main())
