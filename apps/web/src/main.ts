import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { parseManifest, tileTemplate, type Manifest } from "@howmuchhot/tiles";

const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7z"/></svg>';
const pauseIcon =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div id="map" aria-label="Animated temperature map"></div>
  <div class="map-shade" aria-hidden="true"></div>
  <header><a class="brand" href="/">howmuch<span>hot</span><i>°</i></a><span class="eyebrow">A WORLD IN MOTION</span></header>
  <aside class="dataset"><span class="dot"></span><span id="source">Loading temperature tiles…</span></aside>
  <section class="intro"><div class="tag">2-METER AIR TEMPERATURE</div><h1>Feel the bigger picture.</h1><p>Explore temperature across the planet, one moment at a time.</p></section>
  <div class="bottom-panel">
    <div id="error" role="alert" hidden><span id="error-message"></span><button id="retry" type="button">Reload map</button></div>
    <section class="controls" aria-label="Animation controls" aria-busy="true">
      <div class="time-row"><span class="tag">TEMPERATURE TIMELINE <span id="mode"></span></span><time id="time">—</time></div>
      <div class="play-row"><button id="play" type="button" aria-label="Play animation" aria-pressed="false" disabled>${playIcon}</button><div class="scrubber"><label class="sr-only" for="timeline">Weather snapshot</label><input id="timeline" type="range" min="0" max="1" step="1" value="0" disabled><div class="ticks"><span id="start">—</span><span id="cadence">Snapshot interpolation</span><span id="end">—</span></div></div></div>
      <div class="legend"><span>°C</span><span id="minimum">−40</span><div class="gradient"></div><span id="maximum">45</span><span class="resolution" id="resolution">XYZ · Web Mercator</span></div>
      <div class="playback-state"><span id="status" role="status">Loading dataset…</span><span>Visual crossfade, not per-second weather data</span></div>
    </section>
    <footer>Zoom to explore · drag to travel <span>Temperature snapshots, animated in your browser</span></footer>
  </div>
`;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const play = el<HTMLButtonElement>("play");
const timeline = el<HTMLInputElement>("timeline");
const controls = document.querySelector<HTMLElement>(".controls")!;
document.querySelector<HTMLAnchorElement>(".brand")!.href = location.pathname + location.search;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
el("retry").addEventListener("click", () => location.reload());

function showError(message: string) {
  el("error-message").textContent = message;
  el("error").hidden = false;
  el("status").textContent = "Unable to load map";
  controls.setAttribute("aria-busy", "false");
}

async function start() {
  const response = await fetch("/api/manifest");
  if (!response.ok)
    throw new Error(
      "No real weather tiles are published yet. Run `vp run weather:refresh` with the local container server running, then reload.",
    );
  let manifest: Manifest;
  try {
    manifest = parseManifest(await response.json());
  } catch {
    throw new Error(
      "The temperature manifest is invalid or unavailable. Check the dataset and reload.",
    );
  }
  render(manifest, "/api/tiles");
}

function render(manifest: Manifest, base: string) {
  const map = new maplibregl.Map({
    container: "map",
    center: [55, 19],
    zoom: 1.65,
    minZoom: 0,
    maxZoom: 7,
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    style: {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#111c27" } }],
    },
    attributionControl: false,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

  const preloadOpacity = 0.000001; // Nonzero so MapLibre fetches the hidden buffer's tiles.
  const slotFrames = [manifest.frames.length - 1, 0];
  let current = manifest.frames.length - 1;
  let active = 0;
  let playing = !reducedMotion.matches;
  let pending: number | null = null;
  let fadeStart: number | null = null;
  let lastSwap = 0;
  let ready = false;
  let failed = false;
  let raf: number | null = null;
  let timer: number | undefined;

  const format = (index: number, short = false) =>
    new Intl.DateTimeFormat("en-GB", {
      ...(short ? {} : { month: "short", day: "numeric" }),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC",
    }).format(new Date(manifest.frames[index]!.time)) + " UTC";
  const template = (frame: number) =>
    tileTemplate(base, manifest.dataset, manifest.frames[frame]!.id);
  const setStatus = (message: string, busy = false) => {
    if (el("status").textContent !== message) el("status").textContent = message;
    controls.setAttribute("aria-busy", String(busy));
  };
  const updateTime = (frame = current) => {
    const time = el<HTMLTimeElement>("time");
    time.textContent = format(frame);
    time.dateTime = manifest.frames[frame]!.time;
    timeline.value = String(frame);
    timeline.setAttribute("aria-valuetext", format(frame));
  };
  const updatePlay = () => {
    play.innerHTML = playing ? pauseIcon : playIcon;
    play.setAttribute("aria-label", playing ? "Pause animation" : "Play animation");
    play.setAttribute("aria-pressed", String(playing));
  };
  const stage = (frame: number) => {
    const slot = 1 - active;
    if (slotFrames[slot] === frame) return;
    slotFrames[slot] = frame;
    (map.getSource(`temp-${slot}`) as maplibregl.RasterTileSource).setTiles([template(frame)]);
  };
  const cancelFade = () => {
    fadeStart = null;
    lastSwap = performance.now();
    if (!ready) return;
    map.setPaintProperty(`temp-${active}`, "raster-opacity", 1);
    map.setPaintProperty(`temp-${1 - active}`, "raster-opacity", preloadOpacity);
  };
  const wake = () => {
    if (raf === null && ready && !failed && !document.hidden) raf = requestAnimationFrame(tick);
  };
  const commit = () => {
    const next = 1 - active;
    map.setPaintProperty(`temp-${next}`, "raster-opacity", 1);
    map.setPaintProperty(`temp-${active}`, "raster-opacity", preloadOpacity);
    active = next;
    current = slotFrames[active]!;
    pending = null;
    fadeStart = null;
    lastSwap = performance.now();
    updateTime();
    stage((current + 1) % manifest.frames.length);
  };
  function tick(now: number) {
    raf = null;
    if (!ready || failed || document.hidden) return;
    const next = 1 - active;
    if (pending !== null) {
      if (!map.isSourceLoaded(`temp-${next}`)) return;
      commit();
    }
    if (!playing) {
      setStatus("Paused · choose a snapshot or press play");
      return;
    }
    if (map.isMoving()) {
      setStatus("Exploring map…");
      return;
    }
    if (!map.isSourceLoaded(`temp-${active}`) || !map.isSourceLoaded(`temp-${1 - active}`)) {
      setStatus("Buffering next snapshot…", true);
      return; // Source events wake playback; don't busy-loop while waiting for the network.
    }
    if (fadeStart === null) {
      const hold = (reducedMotion.matches ? 1350 : 350) - (now - lastSwap);
      if (hold > 0) {
        setStatus("Playing");
        clearTimeout(timer);
        timer = window.setTimeout(wake, hold);
        return;
      }
      fadeStart = now;
      // The incoming image must be above the outgoing image regardless of buffer slot.
      map.moveLayer(`temp-${1 - active}`, "reference");
    }
    const progress = reducedMotion.matches ? 1 : Math.min((now - fadeStart) / 1000, 1);
    // Keep the outgoing image opaque underneath: weights sum to 1, so there is no dark pulse.
    map.setPaintProperty(
      `temp-${1 - active}`,
      "raster-opacity",
      Math.max(preloadOpacity, progress),
    );
    setStatus("Playing");
    if (progress === 1) commit();
    wake();
  }

  timeline.max = String(manifest.frames.length - 1);
  el("source").textContent = `${manifest.source} · latest ${format(manifest.frames.length - 1)}`;
  el("mode").textContent = " / MODEL ANALYSIS";
  const sameDay =
    manifest.frames[0]!.time.slice(0, 10) === manifest.frames.at(-1)!.time.slice(0, 10);
  el("start").textContent = format(0, sameDay);
  el("end").textContent = format(manifest.frames.length - 1, sameDay);
  const spacing =
    (Date.parse(manifest.frames[1]!.time) - Date.parse(manifest.frames[0]!.time)) / 3_600_000;
  const regular = manifest.frames.every(
    (frame, index) =>
      index === 0 ||
      Date.parse(frame.time) - Date.parse(manifest.frames[index - 1]!.time) === spacing * 3_600_000,
  );
  el("cadence").textContent = regular
    ? `${spacing}-hour snapshots · visual crossfade`
    : "Weather snapshots · visual crossfade";
  el("minimum").textContent = `≤${manifest.colorRange[0]}`;
  el("maximum").textContent = `≥${manifest.colorRange[1]}`;
  el("resolution").textContent =
    `${manifest.nativeResolution}° native · zoom ${manifest.minZoom}–${manifest.maxZoom}`;
  updateTime();
  updatePlay();

  play.addEventListener("click", () => {
    playing = !playing;
    cancelFade();
    updatePlay();
    setStatus(playing ? "Playing" : "Paused · choose a snapshot or press play");
    wake();
  });
  timeline.addEventListener("input", () => {
    if (!ready || failed) return;
    playing = false;
    updatePlay();
    cancelFade();
    const target = Number(timeline.value);
    pending = target === current ? null : target;
    if (pending !== null) stage(pending);
    else stage((current + 1) % manifest.frames.length);
    updateTime(target);
    setStatus(
      pending !== null ? "Loading selected snapshot…" : "Paused · choose a snapshot or press play",
      pending !== null,
    );
    wake();
  });
  document.addEventListener("visibilitychange", () => {
    cancelFade();
    wake();
  });
  reducedMotion.addEventListener("change", () => {
    playing = false;
    cancelFade();
    updatePlay();
    setStatus("Paused · motion preference changed");
  });
  map.on("movestart", cancelFade);
  map.on("moveend", wake);
  map.on("sourcedata", wake);
  map.on("error", () => {
    failed = true;
    playing = false;
    cancelFade();
    updatePlay();
    play.disabled = true;
    timeline.disabled = true;
    showError(
      "A map resource could not be loaded. The last snapshot is held; check your connection and reload.",
    );
  });
  map.on("load", () => {
    for (const slot of [0, 1]) {
      map.addSource(`temp-${slot}`, {
        type: "raster",
        tiles: [template(slotFrames[slot]!)],
        tileSize: manifest.tileSize,
        minzoom: manifest.minZoom,
        maxzoom: manifest.maxZoom,
        attribution:
          'NOAA GFS from <a href="https://dynamical.org/catalog/noaa-gfs-analysis-virtual/">dynamical.org</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>',
      });
      map.addLayer({
        id: `temp-${slot}`,
        type: "raster",
        source: `temp-${slot}`,
        paint: {
          "raster-opacity": slot === 0 ? 1 : preloadOpacity,
          "raster-opacity-transition": { duration: 0 },
          "raster-fade-duration": 0,
        },
      });
    }
    map.addSource("reference", {
      type: "geojson",
      data: "/countries.geojson",
      attribution: '<a href="https://www.naturalearthdata.com/">Natural Earth</a> · public domain',
    });
    map.addLayer({
      id: "reference",
      type: "line",
      source: "reference",
      paint: {
        "line-color": "#f2f2e5",
        "line-opacity": 0.5,
        "line-width": 0.7,
      },
    });
    ready = true;
    play.disabled = failed;
    timeline.disabled = failed;
    lastSwap = performance.now();
    setStatus(
      playing ? "Loading temperature tiles…" : "Paused · choose a snapshot or press play",
      playing,
    );
    wake();
  });
}

start().catch((cause: unknown) => {
  el("source").textContent = "Dataset unavailable";
  showError(cause instanceof Error ? cause.message : "Unable to load temperature data");
});
