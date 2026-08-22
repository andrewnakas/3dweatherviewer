"""Quantize regridded wind fields into texture-atlas PNGs + meta.json.

Atlas channels per level tile:
  R = u (east wind), G = v (north wind), B = omega (vertical velocity, Pa/s),
  A = valid mask (inside HRRR domain AND level above ground).
Per-level min/max scaling for each channel lives in meta.json.
"""

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

from config import (
    ATLAS_COLS,
    ATLAS_H,
    ATLAS_ROWS,
    ATLAS_W,
    DATASET_ID,
    EAST,
    LEVELS,
    NORTH,
    SCALE_PAD,
    SOUTH,
    TERRAIN_TILE_INDEX,
    TILE_H,
    TILE_W,
    WEST,
    WX_ATLAS_COLS,
    WX_ATLAS_H,
    WX_ATLAS_ROWS,
    WX_ATLAS_W,
    WX_CONDENSATE_LEVELS,
    WX_ENC,
    WX_TILES,
)

GRAVITY = 9.80665
RHO0, SCALE_H = 1.225, 8500.0  # standard-atmosphere density profile


def w_factor(height_m: float) -> float:
    """m/s of upward motion per Pa/s of omega at this altitude: w = -omega/(rho g)."""
    rho = RHO0 * math.exp(-height_m / SCALE_H)
    return -1.0 / (rho * GRAVITY)


def compute_scales(frames):
    """Per-level min/max of u, v, omega over all frames.

    frames: list of (nlev, H, W, 3) arrays.
    """
    stack = np.stack(frames)  # (nframes, nlev, H, W, 3)
    scales = []
    for i in range(stack.shape[1]):
        entry = {}
        for name, k, min_pad in (("u", 0, 0.5), ("v", 1, 0.5), ("w", 2, 0.05)):
            vals = stack[:, i, :, :, k]
            lo, hi = float(np.nanmin(vals)), float(np.nanmax(vals))
            pad = max((hi - lo) * SCALE_PAD, min_pad)
            entry[f"{name}Min"] = lo - pad
            entry[f"{name}Max"] = hi + pad
        scales.append(entry)
    return scales


def quantize(field, enc):
    """Fixed-scale quantization of a float field to uint8 per a WX_ENC entry.

    NaN (outside the domain, or "field absent" for zeroIsNone channels) maps
    to byte 0. zeroIsNone channels put real data in 1..255 so byte 0 is an
    unambiguous absence sentinel even inside the domain.
    """
    with np.errstate(invalid="ignore"):
        kind = enc["kind"]
        if kind == "linear":
            lo = float(enc.get("min", 0.0))
            t = (field - lo) / (float(enc["max"]) - lo)
        elif kind == "sqrt":
            t = np.sqrt(np.clip(field, 0.0, None) / float(enc["max"]))
        elif kind == "log10":
            t = np.log10(np.clip(field, 0.0, None) + 1.0) / float(enc["div"])
        else:
            raise ValueError(f"unknown encoding kind {kind!r}")
        t = np.clip(t, 0.0, 1.0)
    ok = np.isfinite(t)
    if enc.get("zeroIsNone"):
        q = np.where(ok, np.round(np.nan_to_num(t) * 254.0) + 1.0, 0.0)
    else:
        q = np.where(ok, np.round(np.nan_to_num(t) * 255.0), 0.0)
    return q.astype(np.uint8)


def wx_tile_slice(atlas, index):
    r0 = (index // WX_ATLAS_COLS) * TILE_H
    c0 = (index % WX_ATLAS_COLS) * TILE_W
    return atlas[r0 : r0 + TILE_H, c0 : c0 + TILE_W]


def encode_wx_tile(atlas, index, r, g, b, alpha_mask):
    """Write one quantized RGB triple + validity mask into the weather atlas."""
    tile = wx_tile_slice(atlas, index)
    tile[:, :, 0] = r
    tile[:, :, 1] = g
    tile[:, :, 2] = b
    tile[:, :, 3] = np.where(alpha_mask, 255, 0).astype(np.uint8)


def new_wx_atlas():
    return np.zeros((WX_ATLAS_H, WX_ATLAS_W, 4), dtype=np.uint8)


def wx_meta_block(heights_by_plev):
    """The additive meta.json `weather` block. heights_by_plev: hPa -> m ASL."""
    return {
        "atlas": {"cols": WX_ATLAS_COLS, "rows": WX_ATLAS_ROWS},
        "tile": {"width": TILE_W, "height": TILE_H},
        "tiles": {k: v for k, v in WX_TILES.items()},
        "enc": WX_ENC,
        "condensate": [
            {
                "index": WX_TILES["condensate0"] + i,
                "p": p,
                "heightMeters": round(float(heights_by_plev[p]), 1),
            }
            for i, p in enumerate(WX_CONDENSATE_LEVELS)
        ],
        "frames": [],  # filled by write_output
    }


def encode_terrain_tile(atlas, terrain, t_range):
    """Pack surface elevation (m) 16-bit into R (hi) / G (lo) of the spare tile.
    Linear decode (r*255*256 + g*255)/65535 commutes with bilinear filtering."""
    i = TERRAIN_TILE_INDEX
    r0 = (i // ATLAS_COLS) * TILE_H
    c0 = (i % ATLAS_COLS) * TILE_W
    lo_m, hi_m = t_range
    ok = ~np.isnan(terrain)
    v = np.round(np.clip((np.nan_to_num(terrain) - lo_m) / (hi_m - lo_m), 0, 1) * 65535).astype(np.uint32)
    tile = atlas[r0 : r0 + TILE_H, c0 : c0 + TILE_W]
    tile[:, :, 0] = np.where(ok, v >> 8, 0).astype(np.uint8)
    tile[:, :, 1] = np.where(ok, v & 0xFF, 0).astype(np.uint8)
    tile[:, :, 3] = np.where(ok, 255, 0).astype(np.uint8)


def encode_frame(frame, valid, scales, terrain=None, t_range=None):
    """frame: (nlev, TILE_H, TILE_W, 3); valid: (nlev, TILE_H, TILE_W) bool."""
    atlas = np.zeros((ATLAS_H, ATLAS_W, 4), dtype=np.uint8)
    if terrain is not None:
        encode_terrain_tile(atlas, terrain, t_range)
    for i in range(frame.shape[0]):
        r0 = (i // ATLAS_COLS) * TILE_H
        c0 = (i % ATLAS_COLS) * TILE_W
        s = scales[i]
        ok = valid[i] & ~np.isnan(frame[i]).any(axis=-1)
        tile = atlas[r0 : r0 + TILE_H, c0 : c0 + TILE_W]
        for ch, (lo, hi) in enumerate(
            ((s["uMin"], s["uMax"]), (s["vMin"], s["vMax"]), (s["wMin"], s["wMax"]))
        ):
            q = np.clip((frame[i, :, :, ch].astype(np.float64) - lo) / (hi - lo), 0, 1)
            tile[:, :, ch] = np.where(ok, np.round(q * 255), 0).astype(np.uint8)
        tile[:, :, 3] = np.where(ok, 255, 0).astype(np.uint8)
    return atlas


def write_output(
    out_dir, frames_by_lead, scales, init_time_iso, heights, terrain,
    terrain_hi=None, weather=None,
):
    """frames_by_lead: {lead: (frame, valid, wx_atlas_or_None)};
    heights: per-level meters ASL;
    terrain: (TILE_H, TILE_W) surface elevation in meters;
    terrain_hi: optional meta block for the standalone hi-res terrain PNG;
    weather: optional meta block from wx_meta_block (frames filled here)."""
    out = Path(out_dir)
    (out / "frames").mkdir(parents=True, exist_ok=True)

    t_range = (
        float(np.floor(np.nanmin(terrain) / 10) * 10 - 10),
        float(np.ceil(np.nanmax(terrain) / 10) * 10 + 10),
    )
    frame_entries = []
    wx_entries = []
    for lead, (frame, valid, wx) in sorted(frames_by_lead.items()):
        name = f"frames/f{lead:02d}.png"
        atlas = encode_frame(frame, valid, scales, terrain, t_range)
        Image.fromarray(atlas, "RGBA").save(out / name, optimize=True)
        frame_entries.append({"lead_hours": lead, "file": name})
        if wx is not None and weather is not None:
            wname = f"frames/w{lead:02d}.png"
            Image.fromarray(wx, "RGBA").save(out / wname, optimize=True)
            wx_entries.append({"lead_hours": lead, "file": wname})
    if weather is not None:
        weather = {**weather, "frames": wx_entries}

    meta = {
        "dataset": DATASET_ID,
        "init_time": init_time_iso,
        "bounds": {"west": WEST, "south": SOUTH, "east": EAST, "north": NORTH},
        "tile": {"width": TILE_W, "height": TILE_H},
        "atlas": {"cols": ATLAS_COLS, "rows": ATLAS_ROWS},
        "terrain": {"index": TERRAIN_TILE_INDEX, "hMin": t_range[0], "hMax": t_range[1]},
        **({"terrainHi": terrain_hi} if terrain_hi else {}),
        **({"weather": weather} if weather else {}),
        "frames": frame_entries,
        "levels": [
            {
                "index": i,
                "id": lid,
                "kind": kind,
                "value": value,
                "heightMeters": round(float(heights[i]), 1),
                "wFactor": 0.0 if kind == "height_agl" else round(w_factor(heights[i]), 5),
                **{k: round(v, 3) for k, v in scales[i].items()},
            }
            for i, (lid, kind, value) in enumerate(LEVELS)
        ],
    }
    (out / "meta.json").write_text(json.dumps(meta))
    return meta
