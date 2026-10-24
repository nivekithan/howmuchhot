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
  frames: { id: string; time: string; referenceYears: number; missing?: "source" | "reference" }[];
}

export function tileKey(dataset: string, frame: string, z: number, x: number, y: number) {
  return `datasets/${dataset}/${frame}/${z}/${x}/${y}.png`;
}

export function tileTemplate(base: string, dataset: string, frame: string) {
  return `${base}/${dataset}/${frame}/{z}/{x}/{y}.png`;
}
