import { PostHog } from "posthog-node/edge";
import type { Env } from "./router.ts";

export async function reportSyncFailure(
  env: Env,
  error: unknown,
  properties: Record<string, string | number>,
) {
  const client = new PostHog(env.POSTHOG_KEY, {
    host: env.POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
    requestTimeout: 5000,
    fetchRetryCount: 1,
    enableExceptionAutocapture: false,
  });
  try {
    client.captureException(error, "weather-sync", {
      ...properties,
      service: "howmuchhot-worker",
      environment: "production",
      $process_person_profile: false,
    });
    await client.shutdown(10000);
  } catch (reportError) {
    console.error("PostHog sync failure reporting failed", reportError);
  }
}
