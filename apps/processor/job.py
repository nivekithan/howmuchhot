"""Own the full refresh job; use the Worker's R2 binding through a private hostname."""
import json
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, ProxyHandler, build_opener

from grid import render_tile
from weather import SAFE_ID, prepare

BRIDGE = "http://tiles.r2"
opener = build_opener(ProxyHandler({}))


def storage(method, path, body=None, content_type="application/json"):
    """Small transient network retries; Workflows retries the overall job if necessary."""
    if body is not None and not isinstance(body, bytes):
        body = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    for attempt in range(3):
        try:
            request = Request(BRIDGE + path, data=body, method=method,
                              headers={"Content-Type": content_type})
            with opener.open(request, timeout=45) as response:
                data = response.read()
                return json.loads(data) if data else None
        except HTTPError as error:
            if error.code == 404 and method == "GET":
                return None
            retryable = error.code in (408, 429, 500, 502, 503, 504) or (path == "/publish" and error.code == 409)
            message = error.read(1024).decode(errors="replace")
            if not retryable:
                raise ValueError(f"R2 bridge rejected {method} {path} ({error.code}): {message}") from error
            if attempt == 2:
                raise RuntimeError(f"R2 bridge failed {method} {path} ({error.code}): {message}") from error
        except (URLError, TimeoutError, ConnectionError):
            if attempt == 2:
                raise
        time.sleep(2 ** attempt)


def refresh(dataset):
    if not isinstance(dataset, str) or not SAFE_ID.fullmatch(dataset):
        raise ValueError("Invalid dataset ID")
    prefix = f"/datasets/{dataset}"
    complete = storage("GET", prefix + "/manifest.json")
    if complete:
        return storage("POST", "/publish", complete)
    plan = storage("GET", prefix + "/plan.json")
    manifest, grids = prepare(max_zoom=3, end_time=plan["latestTime"] if plan else None, dataset=dataset)
    if plan:
        if manifest["frames"] != plan["frames"] or manifest["maxZoom"] != plan["maxZoom"]:
            raise ValueError("Source grids changed during a retry; refusing to mix data under one dataset ID")
        manifest = plan  # Preserve the original metadata, including generatedAt, on retries.
    else:
        storage("PUT", prefix + "/plan.json", manifest)
    count = 0
    for frame in manifest["frames"]:
        for z in range(manifest["maxZoom"] + 1):
            for x in range(2**z):
                for y in range(2**z):
                    tile = render_tile(grids[frame["id"]], z, x, y, manifest["maxZoom"])
                    storage("PUT", f"{prefix}/{frame['id']}/{z}/{x}/{y}.png", tile, "image/png")
                    count += 1
        print(f"Uploaded {frame['id']} ({frame['time']}); {count}/765 tiles", flush=True)
    # Only a completely uploaded dataset is eligible to become the active map.
    storage("PUT", prefix + "/manifest.json", manifest)
    result = storage("POST", "/publish", manifest)
    print(f"Weather refresh finished: {json.dumps(result)}", flush=True)
    return result
