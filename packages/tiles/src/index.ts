/** Versioned XYZ Web Mercator raster tile contract shared by the browser and Worker. */
export interface Manifest {
  version: 2;
  dataset: string;
  source: string;
  synthetic: false;
  sourceDataset: "noaa-gfs-analysis-virtual";
  sourceUrl: string;
  generatedAt: string;
  latestTime: string;
  nativeResolution: number;
  units: "°C";
  tileSize: 256;
  minZoom: number;
  maxZoom: number;
  colorRange: [number, number];
  frames: { id: string; time: string; sha256: string; minimumC: number; maximumC: number }[];
}

export const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

export function tileKey(dataset: string, frame: string, z: number, x: number, y: number) {
  if (
    !SAFE_ID.test(dataset) ||
    !SAFE_ID.test(frame) ||
    ![z, x, y].every(Number.isInteger) ||
    z < 0 ||
    z > 12 ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** z ||
    y >= 2 ** z
  ) {
    throw new Error("Invalid tile coordinates");
  }
  return `datasets/${dataset}/${frame}/${z}/${x}/${y}.png`;
}

export function tileTemplate(base: string, dataset: string, frame: string) {
  if (!SAFE_ID.test(dataset) || !SAFE_ID.test(frame)) throw new Error("Invalid frame");
  return `${base}/${dataset}/${frame}/{z}/{x}/{y}.png`;
}

export function parseManifest(value: unknown): Manifest {
  if (!value || typeof value !== "object") throw new Error("Invalid manifest");
  const m = value as Manifest;
  if (
    m.version !== 2 ||
    typeof m.dataset !== "string" ||
    !SAFE_ID.test(m.dataset ?? "") ||
    typeof m.source !== "string" ||
    m.synthetic !== false ||
    m.sourceDataset !== "noaa-gfs-analysis-virtual" ||
    m.sourceUrl !== "https://dynamical.org/catalog/noaa-gfs-analysis-virtual/" ||
    typeof m.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(m.generatedAt)) ||
    typeof m.latestTime !== "string" ||
    !Number.isFinite(Date.parse(m.latestTime)) ||
    m.nativeResolution !== 0.25 ||
    m.units !== "°C" ||
    m.tileSize !== 256 ||
    !Number.isInteger(m.minZoom) ||
    !Number.isInteger(m.maxZoom) ||
    m.minZoom !== 0 ||
    m.maxZoom < m.minZoom ||
    m.maxZoom > 12 ||
    !Array.isArray(m.colorRange) ||
    m.colorRange.length !== 2 ||
    !m.colorRange.every(Number.isFinite) ||
    m.colorRange[0] >= m.colorRange[1] ||
    !Array.isArray(m.frames) ||
    m.frames.length < 2 ||
    m.frames.length > 1000 ||
    m.frames.some(
      (f) =>
        !f ||
        typeof f.id !== "string" ||
        !SAFE_ID.test(f.id ?? "") ||
        typeof f.time !== "string" ||
        !Number.isFinite(Date.parse(f.time)) ||
        typeof f.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(f.sha256) ||
        !Number.isFinite(f.minimumC) ||
        !Number.isFinite(f.maximumC) ||
        f.minimumC > f.maximumC,
    ) ||
    new Set(m.frames.map((f) => f.id)).size !== m.frames.length ||
    m.frames.some((f, i) => i > 0 && Date.parse(f.time) <= Date.parse(m.frames[i - 1]!.time)) ||
    m.frames.at(-1)?.time !== m.latestTime
  ) {
    throw new Error("Unsupported or malformed temperature manifest");
  }
  return m;
}
