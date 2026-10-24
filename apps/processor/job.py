"""Archive first, prepare rolling references, then publish completed hourly tiles."""
import calendar
import json
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from threading import Lock

import httpx
import numpy as np
from isal import igzip

from grid import render_tile
from weather import ARCHIVE_START, DATASET, available_times, decode_grib, frame_id, manifest, source_session, timestamp

PARALLELISM = 8
SOURCE_BATCH = 384
REFERENCE_BATCH = 24
TILE_BATCH = 8
CHECKPOINT_INTERVAL = 24
client = httpx.Client(base_url="http://tiles.r2/", trust_env=False, timeout=60,
                      limits=httpx.Limits(max_connections=PARALLELISM, max_keepalive_connections=PARALLELISM))
source_cache = OrderedDict()
cache_lock = Lock()
cache_bytes = 0


def storage(method, path, body=None, content_type="application/json"):
    if body is not None and not isinstance(body, bytes):
        body = json.dumps(body, separators=(",", ":")).encode()
    for attempt in range(3):
        try:
            response = client.request(method, path, content=body, headers={"Content-Type": content_type})
            if response.status_code == 404 and method == "GET":
                return None
            if response.status_code in (408, 409, 429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            response.raise_for_status()
            if not response.content:
                return None
            return response.json() if "application/json" in response.headers.get("Content-Type", "") else response.content
        except httpx.TransportError:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def cached_source(stamp):
    key = frame_id(stamp)
    with cache_lock:
        data = source_cache.get(key)
        if data is not None:
            source_cache.move_to_end(key)
        return data


def cache_source(stamp, data):
    global cache_bytes
    key = frame_id(stamp)
    with cache_lock:
        old = source_cache.pop(key, None)
        cache_bytes += len(data) - (len(old) if old is not None else 0)
        source_cache[key] = data
        while cache_bytes > 64 * 1024 * 1024:
            _, evicted = source_cache.popitem(last=False)
            cache_bytes -= len(evicted)


def source_key(stamp):
    return f"source/{frame_id(stamp)}.grib2"


def stored_source(stamp):
    data = storage("GET", source_key(stamp))
    if data is None:
        # Keep source data downloaded before the compressed-chunk optimization.
        data = storage("GET", f"source/{frame_id(stamp)}.f32.gz")
    return data


def read_source(stamp):
    data = cached_source(stamp)
    if data is None:
        data = stored_source(stamp)
        if data is None:
            raise RuntimeError(f"Source hour not archived: {timestamp(stamp)}")
        cache_source(stamp, data)
    if data.startswith(b"GRIB"):
        return decode_grib(data)
    return np.frombuffer(igzip.decompress(data), dtype="<f4").reshape(721, 1440)


def completed_prefix(pool, items, operation, checkpoint, interval):
    """Keep workers occupied; checkpoint only a contiguous successful prefix."""
    futures = {pool.submit(operation, item): index for index, item in enumerate(items)}
    done = set()
    cursor = saved = 0
    try:
        for future in as_completed(futures):
            future.result()
            done.add(futures[future])
            while cursor in done:
                done.remove(cursor)
                cursor += 1
            if cursor - saved >= interval or cursor == len(items):
                checkpoint(items[cursor - 1])
                saved = cursor
    except Exception:
        for future in futures:
            future.cancel()
        raise


def historical_dates(date, year):
    if date.month == 2 and date.day == 29 and not calendar.isleap(year):
        return [date.replace(year=year, day=28), date.replace(year=year, month=3, day=1)]
    return [date.replace(year=year)]


def contribution(date, year, source_start):
    stamps = [np.datetime64(d, "s") for d in historical_dates(date, year)]
    if any(stamp < source_start for stamp in stamps):
        return None
    total = np.zeros((721, 1440), dtype="<f8")
    for stamp in stamps:
        total += read_source(stamp)
    return total / len(stamps)


def reference_key(stamp, reference_years=5):
    date = datetime.fromisoformat(timestamp(stamp).removesuffix("Z"))
    policy = "" if reference_years == 5 else f"{reference_years}-years/"
    return f"references/{policy}sums/{date:%m%dT%H}.bin"


def roll_reference(total, count, leaving, entering):
    if leaving is not None:
        total -= leaving
        count -= 1
    if entering is not None:
        total += entering
        count += 1
    return total, count


def prepare_reference(stamp, source_start, reference_years=5):
    date = datetime.fromisoformat(timestamp(stamp).removesuffix("Z"))
    key = reference_key(stamp, reference_years)
    cached = storage("GET", key)
    previous_year = int.from_bytes(cached[:4], "big") if cached else None
    if previous_year == date.year:
        return
    if previous_year == date.year - 1:
        # Store sums/counts, not rounded averages: partial history also rolls correctly.
        total = np.frombuffer(igzip.decompress(cached[5:]), dtype="<f8").reshape(721, 1440).copy()
        count = cached[4]
        leaving = contribution(date, date.year - reference_years - 1, source_start)
        entering = contribution(date, date.year - 1, source_start)
        total, count = roll_reference(total, count, leaving, entering)
    else:
        total = np.zeros((721, 1440), dtype="<f8")
        count = 0
        for year in range(date.year - reference_years, date.year):
            values = contribution(date, year, source_start)
            if values is not None:
                total += values
                count += 1
    if not count:
        raise RuntimeError("No historical reference is available")
    payload = date.year.to_bytes(4, "big") + bytes([count]) + igzip.compress(total.tobytes(), compresslevel=2, mtime=0)
    storage("PUT", key, payload, "application/octet-stream")


def read_reference(stamp, reference_years=5):
    data = storage("GET", reference_key(stamp, reference_years))
    year = int(str(stamp.astype("datetime64[Y]")))
    if data is None or int.from_bytes(data[:4], "big") != year:
        raise RuntimeError(f"Reference not prepared for {timestamp(stamp)}")
    count = data[4]
    total = np.frombuffer(igzip.decompress(data[5:]), dtype="<f8").reshape(721, 1440)
    return (total / count).astype("<f4"), count


def refresh(cutoff=None, window=None):
    """One bounded real-data batch; Workflows owns retries and continuation."""
    started = time.monotonic()
    archive_start = ARCHIVE_START
    archive_stop = None
    reference_years = 5
    dataset = DATASET
    if window is not None:
        archive_start = np.datetime64(window["start"].removesuffix("Z"), "s")
        archive_stop = np.datetime64(window["end"].removesuffix("Z"), "s")
        reference_years = window.get("referenceYears", 5)
        if (not ARCHIVE_START <= archive_start < archive_stop or
                any(stamp != stamp.astype("datetime64[h]") for stamp in (archive_start, archive_stop)) or
                type(reference_years) is not int or not 1 <= reference_years <= 5):
            raise ValueError("Expected an hourly UTC window from 2026 onward and 1–5 reference years")
        dataset = f"{DATASET}-{frame_id(archive_start)}-{frame_id(archive_stop)}-r{reference_years}"
    progress_key = "archive/progress.json" if window is None else f"archive/{dataset}/progress.json"
    dataset_manifest = f"archive/{dataset}/manifest.json"
    progress = storage("GET", progress_key) or {}
    source = source_session(refresh=cutoff is None)
    times = available_times(source)
    source_start = times[0]
    if archive_stop is not None:
        times = times[times < archive_stop]
    if not len(times) or times[-1] < archive_start:
        raise ValueError("No available data in the requested window")
    after = np.datetime64(progress.get("sourceThrough", timestamp(source_start - np.timedelta64(1, "h"))).removesuffix("Z"), "s")
    if cutoff:
        end = np.datetime64(cutoff.removesuffix("Z"), "s")
    else:
        for end in times[-13:][::-1]:
            if end <= after:
                break
            data = cached_source(end)
            if data is None:
                data = stored_source(end)
            if data is None:
                try:
                    data = source.read(end)
                except Exception:
                    if end == times[-13:][0]:
                        raise
                    continue
                storage("PUT", source_key(end), data, "application/octet-stream")
            cache_source(end, data)
            break

    with ThreadPoolExecutor(max_workers=PARALLELISM) as pool:
        source_times = times[times <= end]
        if window is not None:
            target_times = source_times[source_times >= archive_start]
            required = set(target_times.astype("int64").tolist())
            for stamp in target_times:
                date = datetime.fromisoformat(timestamp(stamp).removesuffix("Z"))
                for year in range(date.year - reference_years, date.year):
                    required.update(int(np.datetime64(d, "s").astype("int64")) for d in historical_dates(date, year))
            source_times = source.times[np.isin(source.times.astype("int64"), list(required))]
        missing = source_times[source_times > after]
        if len(missing):
            batch = missing[:SOURCE_BATCH]

            def archive_source(stamp):
                existing = stored_source(stamp)
                if existing is not None:
                    cache_source(stamp, existing)
                    return
                data = cached_source(stamp)
                if data is None:
                    data = source.read(stamp)
                storage("PUT", source_key(stamp), data, "application/octet-stream")
                cache_source(stamp, data)

            def checkpoint_source(stamp):
                progress["sourceThrough"] = timestamp(stamp)
                storage("PUT", progress_key, progress)

            completed_prefix(pool, batch, archive_source, checkpoint_source, CHECKPOINT_INTERVAL)
            print(f"Source archived through {progress['sourceThrough']} — {len(batch)} hours in {time.monotonic() - started:.1f}s", flush=True)
            if len(missing) > SOURCE_BATCH:
                return {"status": "continue", "cutoff": timestamp(end), "phase": "source", **progress}

        # Source archiving is complete before preparing references or generating tiles.
        published = storage("GET", dataset_manifest)
        if published is None:
            active = storage("GET", "archive/manifest.json")
            if active is not None and active["dataset"] == dataset:
                published = active
        frames = published["frames"] if published else []
        first = np.datetime64(frames[-1]["time"].removesuffix("Z"), "s") + np.timedelta64(1, "h") if frames else archive_start
        if first > end:
            return {"status": "complete", "cutoff": timestamp(end), "hours": len(frames)}
        year = int(str(first.astype("datetime64[Y]")))
        year_start = np.datetime64(f"{year}-01-01T00:00:00", "s")
        year_end = np.datetime64(f"{year + 1}-01-01T00:00:00", "s")
        reference_start = max(archive_start, year_start)
        reference_end = min(archive_stop, year_end) if archive_stop is not None else year_end
        reference_after = (np.datetime64(progress["referencesThrough"].removesuffix("Z"), "s")
                           if progress.get("referenceYear") == year else reference_start - np.timedelta64(1, "h"))
        reference_hours = np.arange(reference_after + np.timedelta64(1, "h"), reference_end, np.timedelta64(1, "h"))
        if len(reference_hours):
            batch = reference_hours[:REFERENCE_BATCH]

            def checkpoint_reference(stamp):
                progress.update(referenceYear=year, referencesThrough=timestamp(stamp))
                storage("PUT", progress_key, progress)

            completed_prefix(pool, batch, lambda stamp: prepare_reference(stamp, source_start, reference_years),
                             checkpoint_reference, PARALLELISM)
            print(f"References prepared through {progress['referencesThrough']}", flush=True)
            if len(reference_hours) > REFERENCE_BATCH:
                return {"status": "continue", "cutoff": timestamp(end), "phase": "references", **progress}

        targets = np.arange(first, min(end + np.timedelta64(1, "h"), year_end), np.timedelta64(1, "h"))[:TILE_BATCH]
        for stamp in targets:
            frame = frame_id(stamp)
            prefix = f"datasets/{dataset}/{frame}"
            complete = storage("GET", prefix + "/complete.json")
            if complete is None:
                baseline, years = read_reference(stamp, reference_years)
                values = read_source(stamp) - baseline

                def upload_tile(coordinates):
                    z, x, y = coordinates
                    storage("PUT", f"{prefix}/{z}/{x}/{y}.png", render_tile(values, z, x, y), "image/png")

                tiles = [(z, x, y) for z in range(4) for x in range(2**z) for y in range(2**z)]
                list(pool.map(upload_tile, tiles))
                complete = {"id": frame, "time": timestamp(stamp), "referenceYears": years}
                storage("PUT", prefix + "/complete.json", complete)
            frames.append(complete)

        # A failed/partial batch leaves complete markers for retry, but cannot expose missing tiles.
        storage("POST", "publish", manifest(frames, timestamp(source_start), dataset, reference_years))
        print(f"Published {len(targets)} hours through {frames[-1]['time']} in {time.monotonic() - started:.1f}s", flush=True)
        return {"status": "continue" if targets[-1] < end else "complete", "cutoff": timestamp(end),
                "phase": "tiles", "hours": len(frames), "latestTime": frames[-1]["time"]}
