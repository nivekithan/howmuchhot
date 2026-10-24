import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import flatpickr from "flatpickr";
import "flatpickr/dist/themes/dark.css";
import "./style.css";
import type { Manifest } from "@howmuchhot/tiles";
import { TemperatureLayer } from "./temperature-layer.ts";
import { temperatureGradient } from "./colors.ts";

const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7z"/></svg>';
const pauseIcon =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div id="map" aria-label="Temperature difference from previous years"></div>
  <div class="map-shade" aria-hidden="true"></div>
  <header><a class="brand" href="/">howmuch<span>hot</span><i>°</i></a><h1 class="sr-only">Temperature difference</h1></header>
  <div class="bottom-panel">
    <div id="error" role="alert" hidden><span id="error-message"></span><button id="retry" type="button">Reload map</button></div>
    <section class="controls" aria-label="Animation controls" aria-busy="true">
      <div class="time-row"><label class="date-control"><span class="sr-only">Choose date and time</span><input id="date" type="text" placeholder="Choose date and time" disabled></label><time id="time" class="sr-only">—</time></div>
      <div class="play-row"><button id="play" type="button" aria-label="Play animation" aria-pressed="false" disabled>${playIcon}</button><div class="scrubber"><label class="sr-only" for="timeline">Time in the temperature archive</label><input id="timeline" type="range" min="0" max="1" step="1" value="0" disabled><div class="ticks"><span id="start">—</span><span id="end">—</span></div></div><label class="sr-only" for="speed">Playback speed</label><select id="speed" title="Playback speed"><option value="1">Real time</option><option value="60">1 min / sec</option><option value="3600">1 hr / sec</option></select></div>
      <div class="legend"><div class="legend-end"><span>Cooler</span><span id="minimum">−10°C</span></div><div class="gradient" role="img" aria-label="Temperature difference: purple and blue are cooler, cream is zero, yellow and red are warmer."></div><div class="legend-end"><span>Warmer</span><span id="maximum">+10°C</span></div></div>
      <div id="status" class="sr-only" role="status"></div>
    </section>
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

function render(manifest: Manifest) {
  const minimum = Math.max(new Date(2026, 0, 1).getTime(), Date.parse(manifest.frames[0]!.time));
  const maximum = Date.parse(manifest.latestTime);
  if (maximum < minimum) throw new Error("No data is available for this time yet.");
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
  const tooltip = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 14,
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
    tooltip
      .setLngLat(position)
      .setText(`${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}°C`)
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

  const setStatus = (message: string) => {
    if (el("status").textContent !== message) el("status").textContent = message;
    el("status").classList.toggle("sr-only", !layer.missing);
    controls.setAttribute("aria-busy", "false");
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
      const value = Math.min(maximum, current + elapsed * Number(speed.value));
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

  timeline.min = String(Math.ceil(minimum / 1000));
  timeline.max = String(Math.floor(maximum / 1000));
  const picker = flatpickr(date, {
    enableTime: true,
    enableSeconds: true,
    disableMobile: true,
    dateFormat: "M j, Y · H:i:S",
    time_24hr: true,
    minDate: new Date(minimum),
    maxDate: new Date(maximum),
    defaultDate: new Date(current),
    position: (picker) => {
      const field = date.getBoundingClientRect();
      const calendar = picker.calendarContainer;
      const gap = 12;
      calendar.style.left = `${Math.max(gap, Math.min(field.left + (field.width - calendar.offsetWidth) / 2, innerWidth - calendar.offsetWidth - gap))}px`;
      calendar.style.top = `${Math.max(gap, field.top - calendar.offsetHeight - gap) + scrollY}px`;
      calendar.classList.add("arrowBottom", "arrowCenter");
    },
    onChange: ([selected]) => {
      if (selected) seek(selected.getTime());
    },
    onClose: () => picker.setDate(current),
  });
  el("start").textContent = short.format(minimum);
  el("end").textContent = short.format(maximum);
  el("minimum").textContent = `${manifest.colorRange[0]}°C`;
  el("maximum").textContent = `+${manifest.colorRange[1]}°C`;
  updateTime();
  play.addEventListener("click", () => {
    revision++;
    playing = !playing;
    if (playing && current >= maximum) current = minimum;
    previous = performance.now();
    updatePlay();
    if (playing) wake();
    else setStatus(layer.missing ? "No data for this time" : "Paused");
  });
  timeline.addEventListener("input", () => seek(Number(timeline.value) * 1000));
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
    throw new Error("The temperature map is unavailable. Please try again shortly.");
  render((await response.json()) as Manifest);
}
start().catch((error: unknown) => {
  console.error(error);
  showError(error instanceof Error ? error.message : "Unable to load temperature archive");
});
