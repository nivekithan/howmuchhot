"""Archive first, prepare rolling references, then publish completed hourly tiles."""
import calendar
import json
import resource
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from threading import Lock

import httpx
import numpy as np
from isal import igzip

from grid import render_tile
from weather import ARCHIVE_START, DATASET, MissingHour, available_times, decode_grib, frame_id, manifest, source_session, timestamp

PARALLELISM = 8
HOUR_PARALLELISM = 8
UPLOAD_PARALLELISM = 32
SOURCE_BATCH = 384
REFERENCE_BATCH = 24
TILE_BATCH = 8
CHECKPOINT_INTERVAL = 24
client = httpx.Client(base_url="http://tiles.r2/", trust_env=False, timeout=60,
                      limits=httpx.Limits(max_connections=UPLOAD_PARALLELISM + HOUR_PARALLELISM, max_keepalive_connections=UPLOAD_PARALLELISM + HOUR_PARALLELISM))
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
    return storage("GET", source_key(stamp))


def read_source(stamp):
    data = cached_source(stamp)
    if data is None:
        data = stored_source(stamp)
        if data is None:
            if storage("GET", f"source/{frame_id(stamp)}.missing.json") is not None:
                return None
            raise RuntimeError(f"Source hour not archived: {timestamp(stamp)}")
        cache_source(stamp, data)
    return decode_grib(data)


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
        values = read_source(stamp)
        if values is None:
            return None
        total += values
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
    # A zero count is an unavailable reference, never a zero-degree temperature.
    payload = date.year.to_bytes(4, "big") + bytes([count]) + igzip.compress(total.tobytes(), compresslevel=2, mtime=0)
    storage("PUT", key, payload, "application/octet-stream")


def read_reference(stamp, reference_years=5):
    data = storage("GET", reference_key(stamp, reference_years))
    year = int(str(stamp.astype("datetime64[Y]")))
    if data is None or int.from_bytes(data[:4], "big") != year:
        raise RuntimeError(f"Reference not prepared for {timestamp(stamp)}")
    count = data[4]
    if not count:
        return None, 0
    total = np.frombuffer(igzip.decompress(data[5:]), dtype="<f8").reshape(721, 1440)
    return (total / count).astype("<f4"), count


def render_hours(hours, dataset, reference_years=5, metrics=None):
    """Independent immutable outputs only; the coordinator owns publication."""
    started = time.monotonic()
    before = resource.getrusage(resource.RUSAGE_SELF)
    timings = {"inputSeconds": 0, "tileComputeSeconds": 0, "tileUploadSeconds": 0, "tileUploads": 0}
    timing_lock = Lock()
    with ThreadPoolExecutor(max_workers=PARALLELISM) as pool, ThreadPoolExecutor(max_workers=UPLOAD_PARALLELISM) as uploads:
        def render_hour(hour):
            stamp = np.datetime64(hour.removesuffix("Z"), "s")
            frame = frame_id(stamp)
            prefix = f"datasets/{dataset}/{frame}"
            complete = storage("GET", prefix + "/complete.json")
            if complete is None:
                input_started = time.monotonic()
                current = read_source(stamp)
                baseline, years = read_reference(stamp, reference_years) if current is not None else (None, 0)
                with timing_lock:
                    timings["inputSeconds"] += time.monotonic() - input_started
                complete = {"id": frame, "time": timestamp(stamp), "referenceYears": years}
                if current is None or baseline is None:
                    complete["missing"] = "source" if current is None else "reference"
                else:
                    values = current - baseline

                    def upload_tile(coordinates, tile):
                        z, x, y = coordinates
                        upload_started = time.monotonic()
                        storage("PUT", f"{prefix}/{z}/{x}/{y}.png", tile, "image/png")
                        finished = time.monotonic()
                        with timing_lock:
                            timings["tileUploadSeconds"] += finished - upload_started
                            timings["tileUploads"] += 1

                    def render_and_upload(coordinates):
                        compute_started = time.monotonic()
                        tile = render_tile(values, *coordinates)
                        with timing_lock:
                            timings["tileComputeSeconds"] += time.monotonic() - compute_started
                        return uploads.submit(upload_tile, coordinates, tile)

                    tiles = [(z, x, y) for z in range(4) for x in range(2**z) for y in range(2**z)]
                    for uploaded in pool.map(render_and_upload, tiles):
                        uploaded.result()
                storage("PUT", prefix + "/complete.json", complete)
            return complete

        # Separate pools avoid nested-executor deadlocks. Tile work stays bounded
        # while several hours overlap source/reference reads and uploads.
        with ThreadPoolExecutor(max_workers=HOUR_PARALLELISM) as hour_pool:
            frames = list(hour_pool.map(render_hour, hours))
    if metrics is not None:
        after = resource.getrusage(resource.RUSAGE_SELF)
        metrics.update(wallSeconds=round(time.monotonic() - started, 3),
                       cpuSeconds=round(after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime, 3),
                       hourParallelism=HOUR_PARALLELISM, tileParallelism=PARALLELISM,
                       uploadParallelism=UPLOAD_PARALLELISM,
                       summedTimings={key: round(value, 3) for key, value in timings.items()})
    return frames


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
                except MissingHour:
                    if end == times[-13:][0]:
                        raise
                    continue
                storage("PUT", source_key(end), data, "application/octet-stream")
            cache_source(end, data)
            break

    with ThreadPoolExecutor(max_workers=PARALLELISM) as pool:
        source_times = np.arange(source_start, end + np.timedelta64(1, "h"), np.timedelta64(1, "h"))
        if window is not None:
            target_times = source_times[source_times >= archive_start]
            required = set(target_times.astype("int64").tolist())
            for stamp in target_times:
                date = datetime.fromisoformat(timestamp(stamp).removesuffix("Z"))
                for year in range(date.year - reference_years, date.year):
                    required.update(int(np.datetime64(d, "s").astype("int64")) for d in historical_dates(date, year))
            source_times = np.array(sorted(required), dtype="datetime64[s]")
            source_times = source_times[(source_times >= source_start) & (source_times <= end)]
        missing = source_times[source_times > after]
        if len(missing):
            batch = missing[:SOURCE_BATCH]
            missing_hours = set(progress.get("missingSourceHours", []))
            missing_lock = Lock()
            recent_cutoff = np.datetime64(datetime.now(timezone.utc).replace(tzinfo=None), "s") - np.timedelta64(48, "h")

            def archive_source(stamp):
                existing = stored_source(stamp)
                if existing is not None:
                    cache_source(stamp, existing)
                    return
                data = cached_source(stamp)
                if data is None:
                    try:
                        data = source.read(stamp)
                    except MissingHour:
                        # Recent chunks can still be delivered. Network errors and corrupt
                        # chunks also remain failures; only confirmed historical absence is skipped.
                        if stamp >= recent_cutoff:
                            raise
                        storage("PUT", f"source/{frame_id(stamp)}.missing.json", {
                            "time": timestamp(stamp), "reason": "no-temperature-chunk",
                            "checkedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        })
                        with missing_lock:
                            missing_hours.add(timestamp(stamp))
                        return
                storage("PUT", source_key(stamp), data, "application/octet-stream")
                cache_source(stamp, data)

            def checkpoint_source(stamp):
                progress["sourceThrough"] = timestamp(stamp)
                with missing_lock:
                    progress["missingSourceHours"] = sorted(missing_hours)
                storage("PUT", progress_key, progress)

            completed_prefix(pool, batch, archive_source, checkpoint_source, CHECKPOINT_INTERVAL)
            print(f"Source archived through {progress['sourceThrough']} — {len(batch)} hours checked, {len(missing_hours)} recorded gaps, in {time.monotonic() - started:.1f}s", flush=True)
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
        hours = [timestamp(stamp) for stamp in targets]
        metrics = {}
        frames.extend(render_hours(hours, dataset, reference_years, metrics))

        # A failed/partial batch leaves complete markers for retry, but cannot expose missing tiles.
        storage("POST", "publish", manifest(frames, timestamp(source_start), dataset, reference_years))
        print(f"Published {len(targets)} hours through {frames[-1]['time']} in {time.monotonic() - started:.1f}s", flush=True)
        return {"status": "continue" if targets[-1] < end else "complete", "cutoff": timestamp(end),
                "phase": "tiles", "hours": len(frames), "latestTime": frames[-1]["time"],
                **metrics}
