import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Public "view in browser" page for issues that have been sent. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [issue] = await query<{ html: string | null }>("select html from issues where id = $1 and status = 'sent'", [Number(id) || 0]);
  if (!issue?.html) return new Response("Issue not found", { status: 404 });
  return new Response(issue.html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
