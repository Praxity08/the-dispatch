import { after } from "next/server";
import { isAuthorizedCron } from "@/lib/auth";
import { draftIssue } from "@/lib/draft";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_CHAIN = 15;

/**
 * Wednesday afternoon: score, select and draft this week's issue. It never sends anything.
 * Each call does as much as fits in one function invocation; if work remains it calls itself
 * again (up to MAX_CHAIN hops). The scheduled retries in vercel.json are a backup.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });

  // A single Gemini call can take up to ~3 minutes, so only start new steps in the first ~60s.
  const result = await draftIssue({ budgetMs: 60_000 });

  const url = new URL(req.url);
  const hop = Number(url.searchParams.get("hop") ?? 0);
  if (result.status === "collecting" && hop < MAX_CHAIN) {
    url.searchParams.set("hop", String(hop + 1));
    // Fire the next hop and stop waiting after a few seconds: the next invocation keeps running
    // on its own (Vercel doesn't cancel a function when its caller disconnects).
    after(() =>
      fetch(url, {
        headers: { authorization: req.headers.get("authorization") ?? "" },
        signal: AbortSignal.timeout(8_000),
      }).catch((err) => {
        if ((err as Error).name !== "TimeoutError") console.error("draft chain failed", err);
      }),
    );
  }
  return Response.json({ ...result, hop });
}
