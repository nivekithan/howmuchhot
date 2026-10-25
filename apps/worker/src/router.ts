import { Hono } from "hono";
import { cache } from "hono/cache";
import { tileKey, type Manifest } from "@howmuchhot/tiles";
import type { RefreshParams } from "./refresh.ts";
import type { TemperatureProcessor } from "./index.ts";

export interface Env {
  POSTHOG_KEY: string;
  POSTHOG_HOST: string;
  TILES: R2Bucket;
  PROCESSOR: DurableObjectNamespace<TemperatureProcessor>;
  WEATHER_REFRESH: Workflow<RefreshParams>;
}

export const app = new Hono<{ Bindings: Env }>();
const MANIFEST_CACHE_CONTROL = "public, max-age=0, s-maxage=600";
const TILE_CACHE_CONTROL = "public, max-age=86400, immutable";

app.get("/api/health", (c) => c.json({ ok: true }));

app.get(
  "/api/manifest",
  cache({
    cacheName: "weather-manifest",
    // Only the latest pointer is mutable; browsers revalidate and the edge keeps it briefly.
    cacheControl: MANIFEST_CACHE_CONTROL,
    keyGenerator: (c) => new URL("/api/manifest", c.req.url).href,
  }),
  async (c) => {
    const object = await c.env.TILES.get("archive/manifest.json");
    if (!object)
      return c.json(
        {
          error:
            "No real weather dataset published yet. Wait for the scheduled refresh or run `vp run weather:refresh` locally.",
        },
        404,
      );
    const manifest = await object.json<Manifest>();
    return c.json(manifest, 200, { "Cache-Control": MANIFEST_CACHE_CONTROL });
  },
);

app.get(
  "/api/tiles/:dataset/:frame/:z{[0-9]+}/:x{[0-9]+}/:file{[0-9]+\\.png}",
  cache({
    cacheName: "weather-tiles",
    cacheControl: TILE_CACHE_CONTROL,
    keyGenerator: (c) => c.req.path,
  }),
  async (c) => {
    const { dataset, frame, z, x, file } = c.req.param();
    const key = tileKey(dataset, frame, Number(z), Number(x), Number(file.slice(0, -4)));
    const object = await c.env.TILES.get(key);
    if (!object) return c.json({ error: "Tile not found" }, 404);
    return c.body(object.body, 200, {
      "Content-Type": "image/png",
      "Cache-Control": TILE_CACHE_CONTROL,
      ETag: object.httpEtag,
    });
  },
);
