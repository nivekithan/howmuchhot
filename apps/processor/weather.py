"""Read actual hourly GFS analysis from Dynamical, never synthetic weather."""
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import dynamical_catalog
import numpy as np

SOURCE_DATASET = "noaa-gfs-analysis-virtual"
SOURCE_URL = "https://dynamical.org/catalog/noaa-gfs-analysis-virtual/"
SAFE_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\Z")
FRAME_COUNT = 9
FRAME_SPACING_HOURS = 3


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


def timestamp(value):
    return np.datetime_as_string(np.datetime64(value, "s"), unit="s") + "Z"


def normalize_grid(field):
    """Normalize provider coordinates to periodic longitude and north-to-south rows."""
    units = field.attrs.get("units", "")
    values = np.asarray(field.transpose("latitude", "longitude").values, dtype=np.float32)
    if units in ("K", "kelvin", "Kelvin"):
        values = values - np.float32(273.15)
    elif units not in ("degree_Celsius", "degrees_Celsius", "degC", "C", "°C", "celsius"):
        raise ValueError(f"Unsupported temperature units from Dynamical: {units!r}")
    latitude = np.asarray(field.latitude.values, dtype=float)
    longitude = np.asarray(field.longitude.values, dtype=float) % 360
    order = np.argsort(longitude)
    longitude, values = longitude[order], values[:, order]
    order = np.argsort(latitude)[::-1]
    latitude, values = latitude[order], values[order, :]
    dx, dy = float(longitude[1] - longitude[0]), float(latitude[0] - latitude[1])
    if not (np.isclose(dx, 0.25) and np.isclose(dy, 0.25) and
            np.isclose(len(longitude) * dx, 360) and np.allclose(np.diff(longitude), dx) and
            np.allclose(np.diff(latitude), -dy) and
            np.isclose(latitude[0], 90) and np.isclose(latitude[-1], -90)):
        raise ValueError("Expected a complete global 0.25-degree Dynamical GFS grid")
    finite = values[np.isfinite(values)]
    if finite.size < values.size * 0.99 or finite.min() < -150 or finite.max() > 100:
        raise ValueError("Temperature grid is incomplete or physically implausible")
    values = np.ascontiguousarray(values, dtype="<f4")
    return {"values": values, "north": float(latitude[0]), "west": float(longitude[0]),
            "dx": dx, "dy": dy, "minimumC": round(float(finite.min()), 2),
            "maximumC": round(float(finite.max()), 2), "sha256": hashlib.sha256(values.tobytes()).hexdigest()}


def prepare(max_zoom=3, end_time=None, dataset=None):
    if type(max_zoom) is not int or not 0 <= max_zoom <= 3:
        raise ValueError("Supported tile zoom levels are 0–3")
    dataset = dataset or f"dynamical-{uuid.uuid4().hex}"
    if not isinstance(dataset, str) or not SAFE_ID.fullmatch(dataset):
        raise ValueError("Invalid dataset ID")
    ds = dynamical_catalog.open(SOURCE_DATASET, chunks=None)
    try:
        variable = ds["temperature_2m"]
        times = np.asarray(variable.time.values).astype("datetime64[s]")
        if np.any(np.isnat(times)) or np.any(times[1:] <= times[:-1]):
            raise ValueError("Dynamical time coordinates are not ordered timestamps")
        now = datetime.now(timezone.utc)
        cutoff = (np.datetime64(datetime.fromisoformat(end_time.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None), "s")
                  if end_time else np.datetime64(now.replace(tzinfo=None), "s"))
        available = times[times <= cutoff]
        if not len(available):
            raise ValueError("Dynamical has no analysis timestamps available before the requested time")
        # Metadata may lead actual delivery. Check a bounded recent window for a complete grid.
        candidates = [cutoff] if end_time else available[-13:][::-1]
        latest = None
        latest_grid = None
        last_error = None
        for candidate in candidates:
            if candidate not in times:
                raise ValueError("The original analysis timestamp is no longer available")
            if not end_time and now.timestamp() - candidate.astype("datetime64[s]").astype(int) > 48 * 3600:
                raise ValueError("Dynamical's latest available analysis is over 48 hours old")
            try:
                print(f"Reading Dynamical temperature_2m at {timestamp(candidate)}…", flush=True)
                latest_grid = normalize_grid(variable.sel(time=candidate))
                latest = candidate
                break
            except Exception as error:
                last_error = error
                if end_time:
                    raise
        if latest is None:
            raise RuntimeError("No complete recent temperature grid available from Dynamical") from last_error
        selected = [latest - np.timedelta64(FRAME_SPACING_HOURS * i, "h") for i in reversed(range(FRAME_COUNT))]
        frames, grids = [], {}
        for i, valid_time in enumerate(selected):
            if valid_time not in times:
                raise ValueError("Dynamical analysis window has a missing timestamp")
            frame_id = f"t{i:03d}"
            grid = latest_grid if valid_time == latest else normalize_grid(variable.sel(time=valid_time))
            grids[frame_id] = grid
            frames.append({"id": frame_id, "time": timestamp(valid_time), "minimumC": grid["minimumC"],
                           "maximumC": grid["maximumC"], "sha256": grid["sha256"]})
            print(f"{frame_id}: {timestamp(valid_time)}, {grid['values'].shape}, {grid['minimumC']}…{grid['maximumC']} °C", flush=True)
        manifest = {"version": 2, "dataset": dataset, "source": "NOAA GFS analysis from dynamical.org",
                    "sourceDataset": SOURCE_DATASET, "sourceUrl": SOURCE_URL, "synthetic": False,
                    "generatedAt": iso(datetime.now(timezone.utc)), "latestTime": timestamp(latest),
                    "nativeResolution": 0.25, "units": "°C", "tileSize": 256, "minZoom": 0,
                    "maxZoom": max_zoom, "colorRange": [-40, 45], "frames": frames}
        return manifest, grids
    finally:
        ds.close()


def write_manifest(path, manifest):
    path = Path(path)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, indent=2))
    temporary.replace(path)
