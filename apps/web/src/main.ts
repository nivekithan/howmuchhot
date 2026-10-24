import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { parseManifest, type Manifest } from "@howmuchhot/tiles";
import { TemperatureLayer } from "./temperature-layer.ts";
import { temperatureGradient } from "./colors.ts";

const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7z"/></svg>';
const pauseIcon =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div id="map" aria-label="Temperature difference from previous years"></div>
  <div class="map-shade" aria-hidden="true"></div>
  <header><a class="brand" href="/">howmuch<span>hot</span><i>°</i></a><span class="eyebrow">A WORLD IN MOTION</span></header>
  <aside class="dataset"><span class="dot"></span><span id="source">Loading temperature archive…</span></aside>
  <section class="intro"><div class="tag">WARMER OR COOLER THAN RECENT YEARS?</div><h1>Feel the bigger picture.</h1><p id="comparison">Temperature differences against previous years, at the same UTC day and hour.</p></section>
  <div class="bottom-panel">
    <div id="error" role="alert" hidden><span id="error-message"></span><button id="retry" type="button">Reload map</button></div>
    <section class="controls" aria-label="Animation controls" aria-busy="true">
      <div class="time-row"><span class="tag">TEMPERATURE DIFFERENCE</span><time id="time">—</time></div>
      <div class="play-row"><button id="play" type="button" aria-label="Play animation" aria-pressed="false" disabled>${playIcon}</button><div class="scrubber"><label class="sr-only" for="timeline">Time in the temperature archive</label><input id="timeline" type="range" min="0" max="1" step="1" value="0" disabled><div class="ticks"><span id="start">—</span><span id="cadence">Hourly data · per-second interpolation</span><span id="end">—</span></div></div></div>
      <div class="time-options"><label>Local time <input id="date" type="datetime-local" step="1" disabled></label><label>Playback <select id="speed"><option value="1">1 second / second (1×)</option><option value="60">1 minute / second (60×)</option><option value="3600">1 hour / second (3,600×)</option></select></label></div>
      <div class="legend"><span>Δ°C</span><span id="minimum">−10</span><div class="gradient" role="img" aria-label="Purple, blue and cyan are cooler; cream is zero; yellow, orange and red are warmer."></div><span id="maximum">+10</span><span class="resolution">0.25° source · zoom 0–3</span></div>
      <div class="playback-state"><span id="status" role="status">Loading archive…</span><span>Interpolated estimates, not per-second measurements</span></div>
      <div class="reference-note" id="reference">Rolling five-year reference</div>
    </section>
    <footer>Purple / blue = cooler · yellow / orange / red = warmer <span>Hourly analyses · interpolated estimates</span></footer>
  </div>
`;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const play = el<HTMLButtonElement>("play");
const timeline = el<HTMLInputElement>("timeline");
const date = el<HTMLInputElement>("date");
const speed = el<HTMLSelectElement>("speed");
const controls = document.querySelector<HTMLElement>(".controls")!;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
document.querySelector<HTMLElement>(".gradient")!.style.background = temperatureGradient;
el("retry").addEventListener("click", () => location.reload());

function showError(message: string) {
  el("error-message").textContent = message;
  el("error").hidden = false;
  el("status").textContent = "Unable to load archive";
  controls.setAttribute("aria-busy", "false");
}

function localInput(milliseconds: number) {
  const value = new Date(milliseconds);
  return new Date(milliseconds - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function render(manifest: Manifest) {
  const minimum = Math.max(new Date(2026, 0, 1).getTime(), Date.parse(manifest.frames[0]!.time));
  const maximum = Date.parse(manifest.latestTime);
  if (maximum < minimum)
    throw new Error(
      "The initial backfill has not yet reached January 1 in your timezone. Please return when more hours have been processed.",
    );
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
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution:
        'NOAA GFS from <a href="https://dynamical.org/catalog/noaa-gfs-analysis-virtual/">dynamical.org</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>',
    }),
    "bottom-right",
  );
  const layer = new TemperatureLayer(manifest);
  const formatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
  const short = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  let current = minimum;
  let playing = false;
  let ready = false;
  let revision = 0;
  let raf: number | null = null;
  let previous = performance.now();
  let displayedSecond = NaN;

  const setStatus = (message: string, busy = false) => {
    if (el("status").textContent !== message) el("status").textContent = message;
    if (controls.getAttribute("aria-busy") !== String(busy))
      controls.setAttribute("aria-busy", String(busy));
  };
  const updatePlay = () => {
    play.innerHTML = playing ? pauseIcon : playIcon;
    play.setAttribute("aria-label", playing ? "Pause animation" : "Play animation");
    play.setAttribute("aria-pressed", String(playing));
  };
  const updateTime = () => {
    const second = Math.floor(current / 1000);
    if (second === displayedSecond) return;
    displayedSecond = second;
    const time = el<HTMLTimeElement>("time");
    time.textContent = formatter.format(current);
    time.dateTime = new Date(current).toISOString();
    timeline.value = String(Math.floor(current / 1000));
    timeline.setAttribute("aria-valuetext", formatter.format(current));
    if (document.activeElement !== date) date.value = localInput(current);
    const index = Math.max(
      0,
      Math.min(
        manifest.frames.length - 1,
        Math.floor((current - Date.parse(manifest.frames[0]!.time)) / 3_600_000),
      ),
    );
    const frame = manifest.frames[index]!;
    const year = new Date(frame.time).getUTCFullYear();
    const reference =
      manifest.referenceWindowYears === 1
        ? String(year - 1)
        : `${year - manifest.referenceWindowYears}–${year - 1}`;
    el("reference").textContent =
      `${reference} reference · ${frame.referenceYears} available ${frame.referenceYears === 1 ? "year" : "years"}${frame.referenceYears < manifest.referenceWindowYears ? " (partial history)" : ""}`;
  };
  const fail = (error: unknown) => {
    playing = false;
    updatePlay();
    showError(error instanceof Error ? error.message : "Unable to load numeric temperature tiles");
  };
  const wake = () => {
    if (raf === null && ready && playing && !document.hidden) raf = requestAnimationFrame(tick);
  };
  async function draw(value: number) {
    if (!ready) return;
    const requested = revision;
    try {
      if (
        (await layer.show(value, () => setStatus("Loading hourly snapshots…", true))) &&
        requested === revision
      ) {
        current = value;
        updateTime();
        setStatus(
          playing
            ? `Playing · ${speed.selectedOptions[0]!.textContent}`
            : "Paused · choose a time or press play",
        );
      }
    } catch (error) {
      fail(error);
    }
  }
  async function tick(now: number) {
    raf = null;
    if (!playing || document.hidden) return;
    const elapsed = Math.min(1000, Math.max(0, now - previous));
    previous = now;
    if (!map.isMoving()) {
      const value = Math.min(maximum, current + elapsed * Number(speed.value));
      await draw(value);
      previous = performance.now(); // Buffering must not advance the displayed clock.
      if (current >= maximum) {
        playing = false;
        updatePlay();
        setStatus("Latest available analysis reached");
      }
    }
    wake();
  }
  const seek = (value: number) => {
    if (!Number.isFinite(value)) return;
    revision++;
    playing = false;
    updatePlay();
    current = Math.max(minimum, Math.min(maximum, value));
    date.value = localInput(current);
    updateTime();
    void draw(current);
  };

  timeline.min = String(Math.ceil(minimum / 1000));
  timeline.max = String(Math.floor(maximum / 1000));
  date.min = localInput(minimum);
  date.max = localInput(maximum);
  el("start").textContent = short.format(minimum);
  el("end").textContent = short.format(maximum);
  el("source").textContent = `${manifest.source} · latest ${formatter.format(maximum)}`;
  el("comparison").textContent =
    `Temperature differences against the preceding ${manifest.referenceWindowYears === 1 ? "calendar year" : `${manifest.referenceWindowYears} calendar years`}, at the same UTC day and hour.`;
  el("minimum").textContent = `≤${manifest.colorRange[0]}`;
  el("maximum").textContent = `≥+${manifest.colorRange[1]}`;
  updateTime();
  play.addEventListener("click", () => {
    revision++;
    playing = !playing;
    if (playing && current >= maximum) current = minimum;
    previous = performance.now();
    updatePlay();
    if (playing) wake();
    else setStatus("Paused");
  });
  timeline.addEventListener("input", () => seek(Number(timeline.value) * 1000));
  date.addEventListener("change", () => seek(new Date(date.value).getTime()));
  document.addEventListener("visibilitychange", () => {
    previous = performance.now();
    wake();
  });
  reducedMotion.addEventListener("change", () => {
    playing = false;
    revision++;
    updatePlay();
    setStatus("Paused · motion preference changed");
  });
  map.on("moveend", () => {
    revision++;
    void draw(current);
  });
  map.on("error", (event) => fail(event.error));
  map.on("load", () => {
    map.addLayer(layer);
    map.addSource("reference", {
      type: "geojson",
      data: "/countries.geojson",
      attribution: '<a href="https://www.naturalearthdata.com/">Natural Earth</a> · public domain',
    });
    map.addLayer({
      id: "reference-halo",
      type: "line",
      source: "reference",
      paint: {
        "line-color": "#fff9eb",
        "line-opacity": 0.55,
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 2, 3, 2.8, 7, 4],
      },
    });
    map.addLayer({
      id: "reference",
      type: "line",
      source: "reference",
      paint: {
        "line-color": "#182833",
        "line-opacity": 0.95,
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.9, 3, 1.3, 7, 2],
      },
    });
    ready = true;
    play.disabled = false;
    timeline.disabled = false;
    date.disabled = false;
    void draw(current);
  });
}

async function start() {
  const response = await fetch("/api/manifest", { cache: "no-cache" });
  if (!response.ok)
    throw new Error(
      "No hourly anomaly archive has been published yet. The first refresh archives source history before generating tiles; reload after the backfill has progressed.",
    );
  render(parseManifest(await response.json()));
}
start().catch((error: unknown) => {
  console.error(error);
  el("source").textContent = "Archive unavailable";
  showError(error instanceof Error ? error.message : "Unable to load temperature archive");
});
