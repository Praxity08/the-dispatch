import { isAuthorizedCron } from "@/lib/auth";
import { ingestAll } from "@/lib/ingest";
import { processWeek } from "@/lib/process";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Mon–Wed: pull all feeds, then screen / embed / cluster as much as fits in the time limit. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });

  const started = Date.now();
  const ingest = await ingestAll();
  // Leave headroom under maxDuration; anything unfinished is picked up by the next run.
  const processed = await processWeek({ budgetMs: 240_000 - (Date.now() - started) });

  return Response.json({
    week: ingest.week,
    inserted: ingest.totalInserted,
    failedSources: ingest.results.filter((r) => r.error).map((r) => r.source),
    processed,
  });
}
