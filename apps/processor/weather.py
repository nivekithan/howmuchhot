"""Hourly global 0.25° temperatures from Dynamical's GFS analysis archive."""
from datetime import datetime, timezone

import dynamical_catalog
import gribberish
import numpy as np
import xarray as xr
import zarr
from zarr.core.buffer import default_buffer_prototype
from zarr.core.sync import sync

SOURCE_DATASET = "noaa-gfs-analysis-virtual"
SOURCE_URL = "https://dynamical.org/catalog/noaa-gfs-analysis-virtual/"
ARCHIVE_START = np.datetime64("2025-12-31T10:00:00", "s")  # Jan 1 in UTC+14.
DATASET = "anomaly-v1"


def timestamp(value):
    return np.datetime_as_string(np.datetime64(value, "s"), unit="s") + "Z"


def frame_id(value):
    return np.datetime_as_string(np.datetime64(value, "h"), unit="h").replace("-", "")


def normalize_grid(field):
    values = np.asarray(field.transpose("latitude", "longitude").values, dtype="<f4")
    units = field.attrs.get("units", "")
    if units in ("K", "kelvin", "Kelvin"):
        values = values - np.float32(273.15)
    elif units not in ("degree_Celsius", "degrees_Celsius", "degC", "C", "°C", "celsius"):
        raise ValueError(f"Unsupported temperature units: {units!r}")
    longitude = np.asarray(field.longitude.values) % 360
    values = values[:, np.argsort(longitude)]
    values = values[np.argsort(np.asarray(field.latitude.values))[::-1], :]
    if values.shape != (721, 1440) or not np.isfinite(values).all():
        raise ValueError("Expected a complete global 0.25° temperature grid")
    return np.ascontiguousarray(values, dtype="<f4")


class Source:
    """One pinned Dynamical index; retrieve compressed hourly GRIB chunks unchanged."""
    def __init__(self):
        self.store = dynamical_catalog.get_store(SOURCE_DATASET)
        root = zarr.open_group(store=self.store, mode="r")
        self.temperature = root["temperature_2m"]
        coordinate = root["time"]
        self.times = xr.decode_cf(xr.Dataset(coords={
            "time": ("time", coordinate[:], dict(coordinate.attrs))
        })).time.values.astype("datetime64[s]")
        expected_codecs = [
            {"name": "scale_offset", "configuration": {"offset": -273.15}},
            {"name": "gribberish", "configuration": {
                "var": "TMP", "adjust_longitude_range": True, "north_up": True,
            }},
        ]
        if (self.temperature.chunks != (1, 721, 1440) or
                list(self.temperature.metadata.to_dict()["codecs"]) != expected_codecs or
                not np.array_equal(root["latitude"][:], np.linspace(90, -90, 721)) or
                not np.array_equal(root["longitude"][:], np.arange(-180, 180, 0.25))):
            raise ValueError("Dynamical's temperature chunk encoding has changed")

    def read(self, stamp):
        index = int(np.searchsorted(self.times, stamp))
        if index == len(self.times) or self.times[index] != stamp:
            raise ValueError(f"Unavailable Dynamical hour: {timestamp(stamp)}")
        key = "temperature_2m/" + self.temperature.metadata.encode_chunk_key((index, 0, 0))
        buffer = sync(self.store.get(key, default_buffer_prototype()))
        if buffer is None:
            raise ValueError(f"Undelivered Dynamical hour: {timestamp(stamp)}")
        data = buffer.to_bytes()
        if not data.startswith(b"GRIB") or not data.endswith(b"7777"):
            raise ValueError("Incomplete Dynamical GRIB chunk")
        return data


_source = None


def source_session(refresh=False):
    global _source
    if refresh or _source is None:
        replacement = Source()
        if _source is not None:
            _source.store.close()
        _source = replacement
    return _source


def decode_grib(data):
    values = gribberish.parse_grib_array(data, 0, True, True).reshape(721, 1440)
    # The provider codec converts Kelvin to Celsius and uses -180…180 longitude.
    values = np.ascontiguousarray(np.roll(values - 273.15, 720, axis=1), dtype="<f4")
    if not np.isfinite(values).all():
        raise ValueError("Incomplete temperature grid")
    return values


def available_times(source):
    times = source.times
    now = np.datetime64(datetime.now(timezone.utc).replace(tzinfo=None), "s")
    return times[times <= now]


def manifest(frames, source_start, dataset=DATASET, reference_years=5):
    return {"version": 3, "dataset": dataset, "source": "NOAA GFS analysis from dynamical.org",
            "sourceDataset": SOURCE_DATASET, "sourceUrl": SOURCE_URL, "synthetic": False,
            "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "latestTime": frames[-1]["time"], "sourceStart": source_start,
            "nativeResolution": 0.25, "units": "°C", "tileSize": 256, "minZoom": 0, "maxZoom": 3,
            "encoding": {"format": "png-gray16", "scale": 0.01, "offset": 32768},
            "comparison": "preceding-calendar-years-same-utc-day-hour", "referenceWindowYears": reference_years,
            "colorRange": [-10, 10], "frames": frames}
