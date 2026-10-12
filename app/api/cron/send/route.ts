import { after } from "next/server";
import { isAuthorizedCron } from "@/lib/auth";
import { sendIssue } from "@/lib/send";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_CHAIN = 20;

/**
 * Thursday 8 AM IST: email the week's issue — only if Shreya confirmed it. Large lists are sent over
 * several invocations; each one re-triggers the next until every delivery is done.
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });
  const result = await sendIssue({ budgetMs: 240_000 });

  const url = new URL(req.url);
  const hop = Number(url.searchParams.get("hop") ?? 0);
  if (result.sent && !result.complete && !result.quotaHit && hop < MAX_CHAIN) {
    url.searchParams.set("hop", String(hop + 1));
    after(() =>
      fetch(url, { headers: { authorization: req.headers.get("authorization") ?? "" }, signal: AbortSignal.timeout(8_000) }).catch(() => {}),
    );
  }
  return Response.json({ ...result, hop });
}
