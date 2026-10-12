import { isAdmin } from "@/lib/admin";
import { query } from "@/lib/db";
import { loadEmailIssue, renderHtml } from "@/lib/email";
import { appUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Editor-only preview of the latest issue exactly as subscribers will see it. */
export async function GET() {
  if (!(await isAdmin())) return Response.redirect(`${appUrl()}/admin/login`, 303);
  const [issue] = await query<{ id: number }>("select id from issues order by week_start desc limit 1");
  if (!issue) return new Response("No issue yet", { status: 404 });
  const html = renderHtml(await loadEmailIssue(Number(issue.id)), { unsubscribeUrl: `${appUrl()}/unsubscribe?test=1` });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
