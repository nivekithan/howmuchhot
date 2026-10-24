import type { OutboundHandler } from "@cloudflare/containers";
import { Hono } from "hono";
import type { Manifest } from "@howmuchhot/tiles";
import type { Env } from "./router.ts";

const storage = new Hono<{ Bindings: Env }>();

storage.on("GET", ["/manifest.json", "/datasets/*"], async (c) => {
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

storage.post("/publish", async (c) => {
  const manifest = await c.req.json<Manifest>();
  const current = await c.env.TILES.get("manifest.json");
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
  const published = await c.env.TILES.put("manifest.json", JSON.stringify(manifest), {
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
