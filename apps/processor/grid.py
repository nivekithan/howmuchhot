"""Numeric anomaly tiles: unsigned 16-bit PNG, (sample - 32768) / 100 °C."""
import io
from functools import lru_cache

import numpy as np
from PIL import Image


@lru_cache(maxsize=85)
def coordinates(z, x, y):
    scale = 256 * 2**z
    offsets = np.arange(256) + 0.5
    longitude = ((x * 256 + offsets) / scale * 360 - 180) % 360
    latitude = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y * 256 + offsets) / scale))))
    gx = longitude / 0.25
    gy = np.clip((90 - latitude) / 0.25, 0, 720)
    x0 = np.floor(gx).astype(int) % 1440
    y0 = np.floor(gy).astype(int)
    return x0, (x0 + 1) % 1440, y0, np.minimum(y0 + 1, 720), (gx % 1)[None, :], (gy % 1)[:, None]


def render_tile(values, z, x, y):
    x0, x1, y0, y1, tx, ty = coordinates(z, x, y)
    a = values[np.ix_(y0, x0)] * (1 - tx) + values[np.ix_(y0, x1)] * tx
    b = values[np.ix_(y1, x0)] * (1 - tx) + values[np.ix_(y1, x1)] * tx
    encoded = np.rint((a * (1 - ty) + b * ty) * 100).astype(np.int32) + 32768
    if encoded.min() < 0 or encoded.max() > 65535:
        raise ValueError("Temperature difference exceeds numeric tile encoding")
    output = io.BytesIO()
    Image.fromarray(encoded.astype(np.uint16)).save(output, format="PNG")
    return output.getvalue()
