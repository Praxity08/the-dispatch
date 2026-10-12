import { appUrl } from "./env";

/**
 * Starts one of our own job routes in a separate function invocation (fire-and-forget).
 * Used for long jobs from the dashboard and Telegram, so they get their own time limit.
 */
export async function triggerJob(path: string): Promise<void> {
  await fetch(`${appUrl()}${path}`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    signal: AbortSignal.timeout(8_000),
  }).catch((err) => {
    if ((err as Error).name !== "TimeoutError") throw err;
  });
}
