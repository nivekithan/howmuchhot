/** Hourly numeric anomaly tiles, interpolated before colour mapping in the browser. */
export interface Manifest {
  version: 3;
  dataset: string;
  source: string;
  synthetic: false;
  sourceDataset: "noaa-gfs-analysis-virtual";
  sourceUrl: string;
  sourceStart: string;
  generatedAt: string;
  latestTime: string;
  nativeResolution: 0.25;
  units: "°C";
  tileSize: 256;
  minZoom: 0;
  maxZoom: 3;
  encoding: { format: "png-gray16"; scale: 0.01; offset: 32768 };
  comparison: "preceding-calendar-years-same-utc-day-hour";
  referenceWindowYears: number;
  colorRange: [number, number];
  frames: { id: string; time: string; referenceYears: number }[];
}

export const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

export function tileKey(dataset: string, frame: string, z: number, x: number, y: number) {
  if (
    !SAFE_ID.test(dataset) ||
    !SAFE_ID.test(frame) ||
    ![z, x, y].every(Number.isInteger) ||
    z < 0 ||
    z > 3 ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** z ||
    y >= 2 ** z
  )
    throw new Error("Invalid tile coordinates");
  return `datasets/${dataset}/${frame}/${z}/${x}/${y}.png`;
}

export function tileTemplate(base: string, dataset: string, frame: string) {
  if (!SAFE_ID.test(dataset) || !SAFE_ID.test(frame)) throw new Error("Invalid frame");
  return `${base}/${dataset}/${frame}/{z}/{x}/{y}.png`;
}

export function parseManifest(value: unknown): Manifest {
  const m = value as Manifest;
  if (
    !m ||
    m.version !== 3 ||
    !SAFE_ID.test(m.dataset) ||
    m.synthetic !== false ||
    m.sourceDataset !== "noaa-gfs-analysis-virtual" ||
    m.nativeResolution !== 0.25 ||
    m.tileSize !== 256 ||
    m.minZoom !== 0 ||
    m.maxZoom !== 3 ||
    m.encoding?.format !== "png-gray16" ||
    m.encoding.scale !== 0.01 ||
    m.encoding.offset !== 32768 ||
    m.comparison !== "preceding-calendar-years-same-utc-day-hour" ||
    !Number.isInteger(m.referenceWindowYears) ||
    m.referenceWindowYears < 1 ||
    m.referenceWindowYears > 5 ||
    !Array.isArray(m.colorRange) ||
    m.colorRange.length !== 2 ||
    !m.colorRange.every(Number.isFinite) ||
    m.colorRange[0] >= m.colorRange[1] ||
    !Array.isArray(m.frames) ||
    !m.frames.length ||
    m.frames.some(
      (f, i) =>
        !SAFE_ID.test(f.id) ||
        !Number.isFinite(Date.parse(f.time)) ||
        !Number.isInteger(f.referenceYears) ||
        f.referenceYears < 1 ||
        f.referenceYears > m.referenceWindowYears ||
        (i > 0 && Date.parse(f.time) - Date.parse(m.frames[i - 1]!.time) !== 3_600_000),
    ) ||
    m.frames.at(-1)?.time !== m.latestTime
  )
    throw new Error("Unsupported or malformed temperature archive manifest");
  return m;
}
