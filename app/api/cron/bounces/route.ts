import { isAuthorizedCron } from "@/lib/auth";
import { processInbox } from "@/lib/bounces";
import { emailConfigured } from "@/lib/email";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Daily: process Gmail bounce notices and "unsubscribe" emails. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });
  if (!emailConfigured()) return Response.json({ skipped: "Gmail credentials are not configured" });
  return Response.json(await processInbox());
}
