import { isAuthorizedCron } from "@/lib/auth";
import { sendEarlyLook } from "@/lib/early-look";
import { ingestAll } from "@/lib/ingest";
import { processWeek } from "@/lib/process";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Mon/Tue 7 PM IST: fetch the day's news, dedupe and score it, then post the early look to Telegram. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });
  const started = Date.now();
  const left = () => 250_000 - (Date.now() - started);
  const force = new URL(req.url).searchParams.has("force");

  const ingest = await ingestAll();
  const processed = await processWeek({ budgetMs: Math.min(120_000, left()) });
  const earlyLook = await sendEarlyLook({ budgetMs: Math.max(30_000, left() - 30_000), force });
  return Response.json({ inserted: ingest.totalInserted, processed, earlyLook });
}
