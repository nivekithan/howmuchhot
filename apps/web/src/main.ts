import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import flatpickr from "flatpickr";
import "flatpickr/dist/themes/dark.css";
import "./style.css";
import type { Manifest } from "@howmuchhot/tiles";
import { TemperatureLayer } from "./temperature-layer.ts";
import { temperatureCss, temperatureGradient } from "./colors.ts";
import "./posthog.ts";

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
const chevronIcon = icon('<path d="m6 9 6 6 6-6"/>');
const githubIcon =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
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
    <button id="header-toggle" class="header-toggle" type="button" aria-expanded="false" aria-controls="subtitle credit" aria-label="Show details">${chevronIcon}</button>
    <h1 id="subtitle">How much warmer or cooler than usual</h1>
    <div class="legend">
      <div class="legend-labels" aria-hidden="true"><span>Cooler</span><span>Warmer</span></div>
      <div class="gradient" role="img" aria-label="Temperature difference: blue is cooler, cream is about normal, orange and red are warmer."></div>
      <div id="legend-ticks" class="legend-ticks" aria-hidden="true"></div>
    </div>
    <div id="credit" class="credit">
      <p><span class="credit-long">Weather data</span><span class="credit-short">Data</span> from <a href="https://dynamical.org/" target="_blank" rel="noopener">dynamical.org</a></p>
      <p>
        Made by <a href="https://nivekithan.com" target="_blank" rel="noopener">Nivekithan</a>
        <a class="github" href="https://github.com/nivekithan" target="_blank" rel="noopener" aria-label="Nivekithan on GitHub" title="GitHub">${githubIcon}</a>
      </p>
    </div>
  </header>
  <div class="loading" aria-hidden="true"><span class="spinner"></span>Loading temperature data…</div>
  <div class="bottom-panel">
    <div id="error" role="alert" hidden><span id="error-message"></span><button id="retry" type="button">Reload map</button></div>
    <section class="controls card" aria-label="Animation controls" aria-busy="true">
      <div class="playback">
        <button id="back" class="step" type="button" aria-label="Previous hour" title="Previous hour (←)" disabled>${backIcon}</button>
        <button id="play" type="button" aria-label="Play animation" title="Play (Space)" aria-pressed="false" disabled>${playIcon}</button>
        <button id="forward" class="step" type="button" aria-label="Next hour" title="Next hour (→)" disabled>${forwardIcon}</button>
      </div>
      <button id="date-button" class="date-button" type="button" aria-label="Choose date and time" disabled>
        <span class="date-icon">${calendarIcon}</span>
        <span class="date-text"><strong id="day">—</strong><span id="clock">—</span></span>
      </button>
      <input id="date" class="sr-only" type="text" tabindex="-1" aria-hidden="true" disabled>
      <time id="time" class="sr-only">—</time>
      <div class="scrubber">
        <label class="sr-only" for="timeline">Time in the temperature archive</label>
        <input id="timeline" type="range" min="0" max="1" step="1" value="0" disabled>
        <div id="ticks" class="ticks" aria-hidden="true"></div>
      </div>
      <div class="speed" role="radiogroup" aria-label="Playback speed">
        ${speeds.map(({ value, label, title }) => `<button type="button" role="radio" data-speed="${value}" title="${title}" aria-label="${title}" aria-checked="${value === 1}">${label}</button>`).join("")}
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
let rate = 1;
document.querySelector<HTMLElement>(".gradient")!.style.background = temperatureGradient;
el("retry").addEventListener("click", () => location.reload());
// On phones the subtitle and credits fold away behind this toggle; wider screens always show them.
const headerToggle = el<HTMLButtonElement>("header-toggle");
headerToggle.addEventListener("click", () => {
  const expanded = headerToggle.getAttribute("aria-expanded") !== "true";
  headerToggle.setAttribute("aria-expanded", String(expanded));
  headerToggle.setAttribute("aria-label", expanded ? "Hide details" : "Show details");
  headerToggle.closest("header")!.classList.toggle("is-expanded", expanded);
});

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

  const map = new maplibregl.Map({
    container: "map",
    center: [55, 19],
    zoom: 1.65,
    minZoom: 0,
    maxZoom: 7,
    renderWorldCopies: false,
    // Mercator balloons near the poles; stop panning before Antarctica and the high Arctic.
    // Kept just inside ±180°: bounds on the antimeridian itself crash MapLibre's camera maths.
    maxBounds: [
      [-179.9, -58],
      [179.9, 84],
    ],
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
  const clockFormat = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  const hour12 = clockFormat.resolvedOptions().hour12 ?? false;
  const tickFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  // Open a day behind now and play forward in real time.
  let current = Math.max(minimum, Math.min(maximum, Date.now() - 24 * HOUR));
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

  // Pick a calendar unit that suits the archive length so ticks stay sparse.
  const DAY = 86_400_000;
  const span = maximum - minimum;
  const unit =
    span <= 14 * DAY
      ? "day"
      : span <= 120 * DAY
        ? "week"
        : span <= 3 * 365 * DAY
          ? "month"
          : "year";
  const boundary = new Date(minimum);
  boundary.setHours(0, 0, 0, 0);
  if (unit === "month") boundary.setDate(1);
  if (unit === "year") boundary.setMonth(0, 1);
  const advance = () => {
    if (unit === "day") boundary.setDate(boundary.getDate() + 1);
    else if (unit === "week") boundary.setDate(boundary.getDate() + 7);
    else if (unit === "month") boundary.setMonth(boundary.getMonth() + 1);
    else boundary.setFullYear(boundary.getFullYear() + 1);
  };
  if (unit === "week") boundary.setDate(boundary.getDate() + ((8 - boundary.getDay()) % 7)); // Mondays
  if (boundary.getTime() <= minimum) advance();
  const marks: number[] = [];
  for (; boundary.getTime() <= maximum; advance()) marks.push(boundary.getTime());
  const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short" });
  const label = (time: number) => {
    const value = new Date(time);
    if (unit === "year" || (unit === "month" && value.getMonth() === 0))
      return String(value.getFullYear());
    return unit === "month" ? monthFormat.format(time) : tickFormat.format(time);
  };
  // Label on calendar-friendly steps (e.g. quarterly months), as many as the track fits.
  const steps = { day: [1, 2, 7], week: [1, 2, 4], month: [1, 2, 3, 6], year: [1, 2, 5, 10] }[unit];
  const positionOf = (time: number) => ((time - minimum) / span) * 100;
  const labelled = (step: number) =>
    marks.filter((time, index) => {
      const slot = unit === "month" ? new Date(time).getMonth() : index;
      return slot % step === 0 && positionOf(time) > 4 && positionOf(time) < 96;
    });
  const renderTicks = () => {
    const room = Math.max(3, Math.floor(timeline.clientWidth / 56));
    const every = steps.find((step) => labelled(step).length <= room) ?? steps[steps.length - 1]!;
    const shown = new Set(labelled(every));
    el("ticks").innerHTML = marks
      .map((time) => {
        const text = shown.has(time) ? label(time) : "";
        return `<span class="tick${text ? "" : " minor"}" style="left:${positionOf(time)}%">${text}</span>`;
      })
      .join("");
  };
  renderTicks();
  new ResizeObserver(renderTicks).observe(timeline);

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
  // Start fetching newly revealed tiles mid-pan instead of waiting for the gesture to end.
  let moveTimer: number | undefined;
  map.on("move", () => {
    moveTimer ??= window.setTimeout(() => {
      moveTimer = undefined;
      void draw(current);
    }, 200);
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
    // Light land under a translucent temperature layer, so countries stand apart from the dark sea.
    map.addLayer(
      { id: "land", type: "fill", source: "reference", paint: { "fill-color": "#f4f1ea" } },
      "temperature",
    );
    map.addLayer({
      id: "reference",
      type: "line",
      source: "reference",
      paint: {
        "line-color": "#1a2630",
        "line-opacity": 0.7,
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 3, 0.9, 7, 1.5],
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
    void draw(current).then(() => {
      if (!reducedMotion.matches && !playing && current < maximum) togglePlay();
    });
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
