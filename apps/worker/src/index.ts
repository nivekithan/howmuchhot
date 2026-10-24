import { Container } from "@cloudflare/containers";
import { app, type Env } from "./router.ts";
import { enqueueRefresh } from "./refresh.ts";
import { storageBridge } from "./storage.ts";
export { WeatherRefresh } from "./refresh.ts";
export { ContainerProxy } from "@cloudflare/containers";

export class TemperatureProcessor extends Container {
  defaultPort = 8080;
  enableInternet = true;
  sleepAfter = "2m";
}

TemperatureProcessor.outboundByHost = { "tiles.r2": storageBridge };

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env) {
    await enqueueRefresh(env, "cron", controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
