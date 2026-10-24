import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import flatpickr from "flatpickr";
import "flatpickr/dist/themes/dark.css";
import "./style.css";
import type { Manifest } from "@howmuchhot/tiles";
import { TemperatureLayer } from "./temperature-layer.ts";
import { temperatureCss, temperatureGradient } from "./colors.ts";

const icon = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const playIcon = icon(
  '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>',
);
const pauseIcon = icon(
  '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
);
const backIcon = icon('<path d="M11 6 5 12l6 6M19 6l-6 6 6 6"/>');
const forwardIcon = icon('<path d="m13 6 6 6-6 6M5 6l6 6-6 6"/>');
const calendarIcon = icon(
  '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
);
const HOUR = 3_600_000;
const speeds = [
  { value: 1, label: "1×", title: "Real time" },
  { value: 60, label: "1m/s", title: "One minute per second" },
  { value: 3600, label: "1h/s", title: "One hour per second" },
];

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div id="map" aria-label="Temperature difference from previous years"></div>
  <div class="map-shade" aria-hidden="true"></div>
  <header class="card">
    <a class="brand" href="/">howmuch<span>hot</span><i>°</i></a>
    <h1 id="subtitle">How much warmer or cooler is it than last year?</h1>
  </header>
  <div class="loading" aria-hidden="true"><span class="spinner"></span>Loading temperature data…</div>
  <div class="bottom-panel">
    <div id="error" role="alert" hidden><span id="error-message"></span><button id="retry" type="button">Reload map</button></div>
    <section class="controls card" aria-label="Animation controls" aria-busy="true">
      <div class="time-row">
        <button id="date-button" class="date-button" type="button" aria-label="Choose date and time" disabled>
          <span class="date-icon">${calendarIcon}</span>
          <span class="date-text"><strong id="day">—</strong><span id="clock">—</span></span>
        </button>
        <input id="date" class="sr-only" type="text" tabindex="-1" aria-hidden="true" disabled>
        <time id="time" class="sr-only">—</time>
        <div class="speed" role="radiogroup" aria-label="Playback speed">
          ${speeds.map(({ value, label, title }) => `<button type="button" role="radio" data-speed="${value}" title="${title}" aria-label="${title}" aria-checked="${value === 3600}">${label}</button>`).join("")}
        </div>
      </div>
      <div class="play-row">
        <button id="back" class="step" type="button" aria-label="Previous hour" title="Previous hour (←)" disabled>${backIcon}</button>
        <button id="play" type="button" aria-label="Play animation" title="Play (Space)" aria-pressed="false" disabled>${playIcon}</button>
        <button id="forward" class="step" type="button" aria-label="Next hour" title="Next hour (→)" disabled>${forwardIcon}</button>
        <div class="scrubber">
          <label class="sr-only" for="timeline">Time in the temperature archive</label>
          <input id="timeline" type="range" min="0" max="1" step="1" value="0" disabled>
          <div id="ticks" class="ticks" aria-hidden="true"></div>
        </div>
      </div>
      <div class="legend">
        <span class="legend-label">Cooler</span>
        <div class="legend-scale">
          <div class="gradient" role="img" aria-label="Temperature difference: purple and blue are cooler, cream is zero, yellow and red are warmer."></div>
          <div id="legend-ticks" class="legend-ticks" aria-hidden="true"></div>
        </div>
        <span class="legend-label">Warmer</span>
      </div>
      <div id="status" class="sr-only" role="status"></div>
    </section>
  </div>
`;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = el("app");
const play = el<HTMLButtonElement>("play");
const back = el<HTMLButtonElement>("back");
const forward = el<HTMLButtonElement>("forward");
const timeline = el<HTMLInputElement>("timeline");
const date = el<HTMLInputElement>("date");
const dateButton = el<HTMLButtonElement>("date-button");
const speedButtons = [...document.querySelectorAll<HTMLButtonElement>(".speed button")];
const controls = document.querySelector<HTMLElement>(".controls")!;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let rate = 3600;
document.querySelector<HTMLElement>(".gradient")!.style.background = temperatureGradient;
el("retry").addEventListener("click", () => location.reload());

function showError(message: string) {
  el("error-message").textContent = message;
  el("error").hidden = false;
  el("status").textContent = "Unable to load archive";
  controls.setAttribute("aria-busy", "false");
  app.classList.add("is-ready");
}

function render(manifest: Manifest) {
  const minimum = Math.max(new Date(2026, 0, 1).getTime(), Date.parse(manifest.frames[0]!.time));
  const maximum = Date.parse(manifest.latestTime);
  if (maximum < minimum) throw new Error("No data is available for this time yet.");
  const [low, high] = manifest.colorRange;
  const years = manifest.referenceWindowYears;
  const reference =
    years === 1 ? "the same hour last year" : `the same hour over the previous ${years} years`;
  el("subtitle").textContent = `Air temperature vs. ${reference}`;

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
      layers: [{ id: "background", type: "background", paint: { "background-color": "#0b141c" } }],
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
  const tooltip = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 16,
    maxWidth: "none",
    className: "temperature-tooltip",
  });
  let cursor: maplibregl.Point | undefined;
  const updateTooltip = () => {
    if (!cursor) return;
    const position = map.unproject(cursor);
    const value = layer.sample(position.lng, position.lat);
    if (value === undefined) {
      tooltip.remove();
      return;
    }
    const rounded = Math.round(value * 10) / 10;
    const label = rounded > 0 ? "warmer" : rounded < 0 ? "cooler" : "same as last year";
    const swatch = temperatureCss(value / (value < 0 ? -low : high));
    tooltip
      .setLngLat(position)
      .setHTML(
        `<span class="swatch" style="background:${swatch}"></span><strong>${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}°C</strong><span class="tooltip-label">${label}</span>`,
      )
      .addTo(map);
  };
  map.on("mousemove", (event) => {
    cursor = event.point;
    updateTooltip();
  });
  map.getCanvas().addEventListener("mouseleave", () => {
    cursor = undefined;
    tooltip.remove();
  });
  map.on("move", updateTooltip);
  const formatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "long",
  });
  const dayFormat = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const hour12 = clockFormat.resolvedOptions().hour12 ?? false;
  const tickFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  let current = minimum;
  let playing = false;
  let ready = false;
  let revision = 0;
  let raf: number | null = null;
  let previous = performance.now();
  let displayedSecond = NaN;

  const setStatus = (message: string) => {
    if (el("status").textContent !== message) el("status").textContent = message;
    el("status").classList.toggle("sr-only", !layer.missing);
    controls.setAttribute("aria-busy", "false");
  };
  const updatePlay = () => {
    play.innerHTML = playing ? pauseIcon : playIcon;
    play.setAttribute("aria-label", playing ? "Pause animation" : "Play animation");
    play.title = playing ? "Pause (Space)" : "Play (Space)";
    play.setAttribute("aria-pressed", String(playing));
    controls.classList.toggle("is-playing", playing);
  };
  const updateTime = () => {
    const second = Math.floor(current / 1000);
    if (second === displayedSecond) return;
    displayedSecond = second;
    const time = el<HTMLTimeElement>("time");
    time.textContent = formatter.format(current);
    time.dateTime = new Date(current).toISOString();
    el("day").textContent = dayFormat.format(current);
    el("clock").textContent = clockFormat.format(current);
    el("clock").classList.toggle("is-latest", current >= maximum);
    timeline.value = String(second);
    timeline.style.setProperty(
      "--progress",
      `${((current - minimum) / (maximum - minimum || 1)) * 100}%`,
    );
    timeline.setAttribute("aria-valuetext", formatter.format(current));
    back.disabled = !ready || current <= minimum;
    forward.disabled = !ready || current >= maximum;
    if (!picker.isOpen) picker.setDate(current);
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
      if ((await layer.show(value)) && requested === revision) {
        current = value;
        updateTime();
        updateTooltip();
        setStatus(layer.missing ? "No data for this time" : playing ? "Playing" : "Paused");
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
      const value = Math.min(maximum, current + elapsed * rate);
      await draw(value);
      previous = performance.now(); // Buffering must not advance the displayed clock.
      if (current >= maximum) {
        playing = false;
        updatePlay();
        setStatus("Latest available data");
      }
    }
    wake();
  }
  const seek = (value: number) => {
    if (!Number.isFinite(value)) return;
    revision++;
    previous = performance.now();
    current = Math.max(minimum, Math.min(maximum, value));
    picker.setDate(current);
    updateTime();
    void draw(current);
  };
  const step = (direction: 1 | -1) =>
    seek(
      direction > 0 ? Math.floor(current / HOUR + 1) * HOUR : Math.ceil(current / HOUR - 1) * HOUR,
    );
  const togglePlay = () => {
    revision++;
    playing = !playing;
    if (playing && current >= maximum) current = minimum;
    previous = performance.now();
    updatePlay();
    if (playing) wake();
    else setStatus(layer.missing ? "No data for this time" : "Paused");
  };

  timeline.min = String(Math.ceil(minimum / 1000));
  timeline.max = String(Math.floor(maximum / 1000));
  const picker = flatpickr(date, {
    enableTime: true,
    disableMobile: true,
    clickOpens: false,
    dateFormat: "M j, Y · H:i",
    time_24hr: !hour12,
    minDate: new Date(minimum),
    maxDate: new Date(maximum),
    defaultDate: new Date(current),
    position: (picker) => {
      const field = dateButton.getBoundingClientRect();
      const calendar = picker.calendarContainer;
      const gap = 12;
      calendar.style.left = `${Math.max(gap, Math.min(field.left, innerWidth - calendar.offsetWidth - gap))}px`;
      calendar.style.top = `${Math.max(gap, field.top - calendar.offsetHeight - gap) + scrollY}px`;
      calendar.classList.add("arrowBottom");
    },
    onChange: ([selected]) => {
      if (selected) seek(selected.getTime());
    },
    onClose: () => {
      picker.setDate(current);
      dateButton.setAttribute("aria-expanded", "false");
    },
    onOpen: () => dateButton.setAttribute("aria-expanded", "true"),
  });
  dateButton.addEventListener("click", () => picker.toggle());

  // Label each day boundary, thinning them out so long archives stay legible.
  const days: number[] = [];
  const midnight = new Date(minimum);
  midnight.setHours(24, 0, 0, 0);
  for (; midnight.getTime() <= maximum; midnight.setDate(midnight.getDate() + 1))
    days.push(midnight.getTime());
  const every = Math.max(1, Math.ceil(days.length / 6));
  el("ticks").innerHTML = days
    .map((day, index) => {
      const position = ((day - minimum) / (maximum - minimum)) * 100;
      const label = index % every === 0 && position > 6 && position < 94;
      return `<span class="tick${label ? "" : " minor"}" style="left:${position}%">${label ? tickFormat.format(day) : ""}</span>`;
    })
    .join("");

  const format = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value)}°`;
  el("legend-ticks").innerHTML = [low, low / 2, 0, high / 2, high]
    .map((value, index) => `<span style="left:${index * 25}%">${format(value)}</span>`)
    .join("");
  updateTime();

  play.addEventListener("click", togglePlay);
  back.addEventListener("click", () => step(-1));
  forward.addEventListener("click", () => step(1));
  for (const button of speedButtons)
    button.addEventListener("click", () => {
      rate = Number(button.dataset.speed);
      for (const other of speedButtons)
        other.setAttribute("aria-checked", String(other === button));
      previous = performance.now();
    });
  timeline.addEventListener("input", () => seek(Number(timeline.value) * 1000));
  document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (!ready || event.metaKey || event.ctrlKey || event.altKey || picker.isOpen) return;
    if (target.matches("input, select, textarea")) return;
    if (event.key === " " && !target.matches("button")) {
      event.preventDefault();
      togglePlay();
    } else if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      !target.closest("#map")
    ) {
      event.preventDefault();
      step(event.key === "ArrowRight" ? 1 : -1);
    }
  });
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
        "line-opacity": 0.35,
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 1.6, 3, 2.4, 7, 3.5],
      },
    });
    map.addLayer({
      id: "reference",
      type: "line",
      source: "reference",
      paint: {
        "line-color": "#13202a",
        "line-opacity": 0.8,
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 3, 1, 7, 1.6],
      },
    });
    document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    ready = true;
    play.disabled = false;
    timeline.disabled = false;
    date.disabled = false;
    dateButton.disabled = false;
    back.disabled = current <= minimum;
    forward.disabled = current >= maximum;
    app.classList.add("is-ready");
    void draw(current);
  });
}

async function start() {
  const response = await fetch("/api/manifest", { cache: "no-cache" });
  if (!response.ok)
    throw new Error("The temperature map is unavailable. Please try again shortly.");
  render((await response.json()) as Manifest);
}
start().catch((error: unknown) => {
  console.error(error);
  showError(error instanceof Error ? error.message : "Unable to load temperature archive");
});
