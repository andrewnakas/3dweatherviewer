"""Open the dynamical.org virtual HRRR dataset and pick a usable init time."""

import logging

import dynamical_catalog
import numpy as np

from config import DATASET_ID

log = logging.getLogger(__name__)


def open_datasets():
    """Return (surface_ds, pressure_ds, model_level_ds), all lazy Datasets.

    The model-level group carries the native terrain-following levels, which
    is where the 3D smoke field (mass_density) lives.
    """
    sfc = dynamical_catalog.open(DATASET_ID, chunks=None)
    prs = dynamical_catalog.open(DATASET_ID, chunks=None, group="pressure_level")
    mdl = dynamical_catalog.open(DATASET_ID, chunks=None, group="model_level")
    return sfc, prs, mdl


def pick_init(prs, requested: str | None = None, max_steps_back: int = 6, sfc=None):
    """Choose an init_time whose final lead hour is actually readable.

    The virtual dataset lists an init as soon as ingest starts; the last lead
    hours may not exist yet. Probe the final lead and step back an init at a
    time (hourly, on this dataset) until a complete one is found. When sfc is given, the surface group is probed too, so an
    init with wind but missing weather fields is rejected rather than shipping
    black weather tiles.
    """
    if requested and requested != "auto":
        init = np.datetime64(requested)
        _probe(prs, init, sfc)
        return init

    inits = prs.init_time.values
    for i in range(1, max_steps_back + 2):
        init = inits[-i]
        try:
            _probe(prs, init, sfc)
            log.info("using init %s", init)
            return init
        except Exception as e:  # noqa: BLE001 - any read failure means incomplete
            log.warning("init %s not complete (%s); stepping back 6h", init, e)
    raise RuntimeError(f"no complete init found in last {max_steps_back + 1} cycles")


def _probe(prs, init, sfc=None):
    sl = (
        prs.wind_u.sel(init_time=init, pressure_level=500)
        .isel(lead_time=-1, x=slice(890, 910), y=slice(520, 540))
        .values
    )
    if np.isnan(sl).all():
        raise ValueError("probe slice is all-NaN")
    if sfc is not None:
        # t2m rather than reflectivity: reflectivity is legitimately NaN/absent
        # in clear air, temperature never is.
        sl2 = (
            sfc.temperature_2m.sel(init_time=init)
            .isel(lead_time=-1, x=slice(890, 910), y=slice(520, 540))
            .values
        )
        if np.isnan(sl2).all():
            raise ValueError("surface probe slice is all-NaN")
