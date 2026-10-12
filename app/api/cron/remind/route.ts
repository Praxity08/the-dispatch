import { isAuthorizedCron } from "@/lib/auth";
import { sendReminder } from "@/lib/review";

export const dynamic = "force-dynamic";

/** Wednesday 10 PM IST: remind Shreya if the draft isn't confirmed. Never sends the newsletter. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });
  return Response.json(await sendReminder());
}
