import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./router.ts";

export const REFRESH_CRON = "0 */8 * * *";
export interface RefreshParams {
  trigger: string;
}

export async function enqueueRefresh(env: Env, trigger: string, scheduledTime = Date.now()) {
  if (!env.WEATHER_REFRESH) throw new Error("Weather Workflow is not configured");
  const id = `weather-${scheduledTime}`;
  let instance: WorkflowInstance;
  try {
    instance = await env.WEATHER_REFRESH.create({ id, params: { trigger } });
  } catch (error) {
    // Cron delivery may be repeated. Reuse the same instance rather than duplicate a job.
    try {
      instance = await env.WEATHER_REFRESH.get(id);
      await instance.status();
    } catch {
      throw error;
    }
  }
  return { id: instance.id };
}

/** Workflows owns retries; Python owns the entire processing/upload job. */
export class WeatherRefresh extends WorkflowEntrypoint<Env, RefreshParams> {
  async run(event: WorkflowEvent<RefreshParams>, step: WorkflowStep) {
    return step.do(
      "process and publish real weather",
      {
        retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
        timeout: "10 minutes",
      },
      async () => {
        if (!this.env.PROCESSOR) throw new Error("Python container binding is missing");
        const response = await this.env.PROCESSOR.getByName("weather").fetch(
          "http://processor/refresh",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataset: event.instanceId }),
          },
        );
        const result = await response.json<{
          status?: string;
          error?: string;
          detail?: string;
          dataset?: string;
          latestTime?: string;
          tiles?: number;
        }>();
        if (!response.ok || !["complete", "superseded"].includes(result.status ?? "")) {
          throw new Error(
            result.detail || result.error || `Container refresh failed (${response.status})`,
          );
        }
        return result;
      },
    );
  }
}
