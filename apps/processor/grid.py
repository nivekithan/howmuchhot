"""Reproject actual NOAA GFS 2 m temperature grids to Web Mercator XYZ tiles."""
import io
import numpy as np
from PIL import Image

TILE_SIZE = 256
STOPS = np.array([-40, -20, 0, 15, 25, 35, 45], dtype=float)
COLORS = np.array([(61, 51, 145), (65, 105, 205), (55, 190, 197),
                   (184, 216, 115), (249, 200, 78), (238, 116, 62), (176, 43, 68)])


def render_tile(grid, z, x, y, max_zoom):
    if any(type(v) is not int for v in (z, x, y)) or not (
        0 <= z <= max_zoom and 0 <= x < 2**z and 0 <= y < 2**z
    ):
        raise ValueError("Tile outside dataset")
    scale = TILE_SIZE * 2**z
    offsets = np.arange(TILE_SIZE) + 0.5
    longitude = ((x * TILE_SIZE + offsets) / scale * 360 - 180) % 360
    latitude = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y * TILE_SIZE + offsets) / scale))))
    values = grid["values"]
    rows, cols = values.shape
    # GFS is a periodic global longitude grid, with latitudes north to south.
    gx = ((longitude - grid["west"]) % 360) / grid["dx"]
    gy = np.clip((grid["north"] - latitude) / grid["dy"], 0, rows - 1)
    x0 = np.floor(gx).astype(int) % cols
    x1 = (x0 + 1) % cols
    y0 = np.floor(gy).astype(int)
    y1 = np.minimum(y0 + 1, rows - 1)
    tx = (gx - np.floor(gx))[None, :]
    ty = (gy - y0)[:, None]
    a = values[np.ix_(y0, x0)] * (1 - tx) + values[np.ix_(y0, x1)] * tx
    b = values[np.ix_(y1, x0)] * (1 - tx) + values[np.ix_(y1, x1)] * tx
    celsius = a * (1 - ty) + b * ty
    valid = np.isfinite(celsius)
    safe = np.where(valid, celsius, STOPS[0])
    rgba = np.empty((TILE_SIZE, TILE_SIZE, 4), dtype=np.uint8)
    for channel in range(3):
        rgba[:, :, channel] = np.rint(np.interp(safe, STOPS, COLORS[:, channel])).astype(np.uint8)
    rgba[:, :, 3] = np.where(valid, 255, 0)
    output = io.BytesIO()
    Image.fromarray(rgba).save(output, format="PNG")
    return output.getvalue()
