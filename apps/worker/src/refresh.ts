import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./router.ts";

async function processorResult<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Container HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json<T>();
}

export interface RefreshParams {
  trigger: string;
  restartProcessor?: boolean;
  window?: { start: string; end: string; referenceYears?: number };
}

interface RefreshResult {
  status: "complete" | "continue";
  cutoff: string;
}

export async function enqueueRefresh(env: Env, trigger: string, scheduledTime = Date.now()) {
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

/** Workflows owns retries; one Python Container owns processing and publication. */
export class WeatherRefresh extends WorkflowEntrypoint<Env, RefreshParams> {
  async run(event: WorkflowEvent<RefreshParams>, step: WorkflowStep) {
    if (event.payload.restartProcessor) {
      await step.do("restart processor", async () => {
        await this.env.PROCESSOR.getByName("weather", { locationHint: "enam" }).destroy();
        return { restarted: true };
      });
    }
    let cutoff: string | undefined;
    for (let batch = 0; ; batch++) {
      const result: RefreshResult = await step.do(
        `archive batch ${batch}`,
        {
          retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
          timeout: "10 minutes",
        },
        async () => {
          const response = await this.env.PROCESSOR.getByName("weather", {
            locationHint: "enam",
          }).fetch("http://processor/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cutoff, window: event.payload.window }),
          });
          return processorResult<RefreshResult>(response);
        },
      );
      if (result.status === "complete") return result;
      cutoff = result.cutoff;
    }
  }
}
