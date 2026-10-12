import { isAuthorizedCron } from "@/lib/auth";
import { deliverDraft } from "@/lib/review";

export const dynamic = "force-dynamic";

/** Wednesday evening: post the finished draft to Shreya's Telegram group. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });
  return Response.json(await deliverDraft());
}
