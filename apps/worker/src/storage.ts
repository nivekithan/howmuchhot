import type { OutboundHandler } from "@cloudflare/containers";
import { Hono } from "hono";
import type { Manifest } from "@howmuchhot/tiles";
import type { Env } from "./router.ts";

const storage = new Hono<{ Bindings: Env }>();

storage.get("/*", async (c) => {
  const object = await c.env.TILES.get(c.req.path.slice(1));
  if (!object) return c.notFound();
  return c.body(object.body, 200, {
    "Content-Type": object.httpMetadata?.contentType ?? "application/json",
  });
});

storage.put("/datasets/*", async (c) => {
  await c.env.TILES.put(c.req.path.slice(1), await c.req.arrayBuffer(), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: c.req.header("Content-Type") ?? "application/octet-stream" },
  });
  return c.body(null, 204);
});

storage.put("/source/*", async (c) => {
  await c.env.TILES.put(c.req.path.slice(1), await c.req.arrayBuffer(), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: c.req.header("Content-Type") ?? "application/octet-stream" },
  });
  return c.body(null, 204);
});

storage.on("PUT", ["/archive/*", "/references/*"], async (c) => {
  await c.env.TILES.put(c.req.path.slice(1), await c.req.arrayBuffer(), {
    httpMetadata: { contentType: c.req.header("Content-Type") },
  });
  return c.body(null, 204);
});

storage.post("/publish", async (c) => {
  const manifest = await c.req.json<Manifest>();
  const key = `archive/${manifest.dataset}/manifest.json`;
  const previous = await c.env.TILES.get(key);
  if (
    previous &&
    Date.parse((await previous.json<Manifest>()).latestTime) > Date.parse(manifest.latestTime)
  ) {
    return c.json({ status: "superseded", dataset: manifest.dataset });
  }
  const saved = await c.env.TILES.put(key, JSON.stringify(manifest), {
    onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  if (!saved) return c.json({ error: "Dataset publication raced another refresh; retry" }, 409);
  const current = await c.env.TILES.get("archive/manifest.json");
  if (current) {
    const active = await current.json<Manifest>();
    if (Date.parse(active.latestTime) > Date.parse(manifest.latestTime)) {
      return c.json({
        status: "superseded",
        dataset: manifest.dataset,
        latestTime: active.latestTime,
      });
    }
  }
  const published = await c.env.TILES.put("archive/manifest.json", JSON.stringify(manifest), {
    onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  if (!published) return c.json({ error: "Another refresh published first; retry" }, 409);
  return c.json({
    status: "complete",
    dataset: manifest.dataset,
    latestTime: manifest.latestTime,
    tiles: (manifest.frames.length * (4 ** (manifest.maxZoom + 1) - 1)) / 3,
  });
});

// Only reachable through the container's virtual hostname, not the public router.
export const storageBridge: OutboundHandler<Env> = (request, env) => storage.fetch(request, env);
