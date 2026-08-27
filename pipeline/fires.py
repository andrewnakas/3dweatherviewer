"""Active fire hotspots from NASA FIRMS, fetched at build time.

FIRMS publishes 24 h VIIRS detections for the contiguous US as public CSVs —
no API key, which matters because a key must never ship inside a static site.
The pipeline snapshots them each cycle into site/data/fires.json alongside the
forecast, so the page needs no runtime credentials and no cross-origin fetch.

Detections are snapped to a coarse grid and merged, because a single large
fire lights up hundreds of adjacent pixels across two satellites and drawing
each one is both slow and visually wrong: one fire should read as one fire,
with its total radiative power setting how big it burns.
"""

import csv
import io
import json
import logging
import math
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from config import EAST, NORTH, SOUTH, WEST

log = logging.getLogger("fires")

BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
SOURCES = [
    f"{BASE}/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv",
    f"{BASE}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv",
]

MERGE_DEG = 0.02      # ~2 km: one fire, not a constellation of pixels
MAX_FIRES = 4000      # plenty for CONUS; keeps fires.json small
MIN_FRP = 1.0         # MW; drops the faintest single-pixel detections


def _fetch(url, attempts=3, timeout=90):
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "3dweatherviewer"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 - network; retry then give up
            last = e
            log.warning("FIRMS fetch attempt %d failed (%s): %s", i + 1, url, e)
    raise RuntimeError(f"FIRMS fetch failed: {url}") from last


def _rows(text):
    for row in csv.DictReader(io.StringIO(text)):
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
            frp = float(row.get("frp") or 0.0)
        except (TypeError, ValueError):
            continue
        if not (SOUTH <= lat <= NORTH and WEST <= lon <= EAST):
            continue
        # acq_time is HHMM, zero-padded inconsistently
        t = str(row.get("acq_time", "0")).zfill(4)
        try:
            when = datetime.strptime(
                f"{row['acq_date']} {t[:2]}:{t[2:]}", "%Y-%m-%d %H:%M"
            ).replace(tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue
        yield {
            "lat": lat, "lon": lon, "frp": frp,
            "conf": str(row.get("confidence", "")).lower()[:1],  # l/n/h
            "when": when,
            "night": str(row.get("daynight", "")).upper().startswith("N"),
        }


def build_fires(out_dir):
    """Write site/data/fires.json. Returns the meta block, or None on failure."""
    merged = {}
    seen = 0
    for url in SOURCES:
        for d in _rows(_fetch(url)):
            seen += 1
            key = (round(d["lat"] / MERGE_DEG), round(d["lon"] / MERGE_DEG))
            m = merged.get(key)
            if m is None:
                merged[key] = {
                    "lat": d["lat"], "lon": d["lon"], "frp": d["frp"],
                    "n": 1, "when": d["when"], "conf": d["conf"],
                }
                continue
            # FRP-weighted centroid keeps the marker on the hot part
            w = m["frp"] + d["frp"]
            if w > 0:
                m["lat"] = (m["lat"] * m["frp"] + d["lat"] * d["frp"]) / w
                m["lon"] = (m["lon"] * m["frp"] + d["lon"] * d["frp"]) / w
            m["frp"] = w
            m["n"] += 1
            m["when"] = max(m["when"], d["when"])
            if d["conf"] == "h" or m["conf"] != "h":
                m["conf"] = d["conf"]

    fires = [f for f in merged.values() if f["frp"] >= MIN_FRP]
    fires.sort(key=lambda f: f["frp"], reverse=True)
    dropped = max(0, len(fires) - MAX_FIRES)
    fires = fires[:MAX_FIRES]

    now = datetime.now(timezone.utc)
    out = {
        "source": "NASA FIRMS VIIRS (SUOMI-NPP + NOAA-20), 24 h",
        "fetched": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(fires),
        # [lon, lat, frp MW, hours before fetch, confidence 0-2]
        "fires": [
            [
                round(f["lon"], 4), round(f["lat"], 4), round(f["frp"], 1),
                round(max(0.0, (now - f["when"]).total_seconds() / 3600.0), 1),
                {"l": 0, "n": 1, "h": 2}.get(f["conf"], 1),
            ]
            for f in fires
        ],
    }
    path = Path(out_dir) / "fires.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    log.info(
        "FIRMS: %d detections -> %d fires (%d dropped over cap), max %.0f MW",
        seen, len(fires), dropped, fires[0]["frp"] if fires else 0.0,
    )
    return {"file": "fires.json", "count": len(fires), "fetched": out["fetched"],
            "source": out["source"]}
