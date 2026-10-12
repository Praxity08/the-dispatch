import { isAuthorizedCron } from "@/lib/auth";
import { scoreNewStories } from "@/lib/draft";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Scores stories that arrived after the weekly draft, so they rank in the dashboard's story pool. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });
  return Response.json(await scoreNewStories({ budgetMs: 60_000 }));
}
