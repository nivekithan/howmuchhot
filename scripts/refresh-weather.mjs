// Trigger the real scheduled handler once. Workflows runs independently; no polling.
const scheduled = new URL("http://localhost:8787/cdn-cgi/local/scheduled");
scheduled.searchParams.set("cron", "0 */8 * * *");
scheduled.searchParams.set("format", "json");
try {
  const response = await fetch(scheduled);
  const body = await response.text();
  if (!response.ok || JSON.parse(body).outcome !== "ok")
    throw new Error(`Scheduled trigger failed: ${body}`);
  console.log(
    "Weather refresh queued. The Workflow will process and publish tiles in the background.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  if (error?.cause?.code === "ECONNREFUSED") console.error("Start `vp run dev` first.");
  process.exitCode = 1;
}
