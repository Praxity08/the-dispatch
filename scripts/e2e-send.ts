// Dry-run test of the Thursday send path on a throwaway copy of the latest issue.
//   npm run e2e:send       (EMAIL_DRY_RUN=1: nothing is actually emailed; the copy is deleted afterwards)
import { query } from "../lib/db";
import { sendIssue } from "../lib/send";
import { sendTimeFor } from "../lib/week";

process.env.EMAIL_DRY_RUN = "1";
const TEST_WEEK = "2026-09-28";
const TEST_EMAILS = ["dry-run-1@example.com", "dry-run-2@example.com", "dry-run-3@example.com", "dry-run-unsubscribed@example.com"];
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

async function cleanup() {
  await query("delete from issues where week_start = $1", [TEST_WEEK]); // cascades to items and deliveries
  await query("delete from subscribers where email = any($1::text[])", [TEST_EMAILS]);
}

async function main() {
  await cleanup();
  const [source] = await query<{ id: number }>("select id from issues where week_start <> $1 order by week_start desc limit 1", [TEST_WEEK]);
  const [copy] = await query<{ id: number }>(
    `insert into issues (week_start, issue_number, status, subject, intro, confirmed_at)
     select $1, issue_number, 'in_review', '[DRY RUN] ' || subject, intro, null from issues where id = $2 returning id`,
    [TEST_WEEK, source.id],
  );
  const id = Number(copy.id);
  await query(
    `insert into issue_items (issue_id, story_id, article_id, role, position, status, topic, reason, commentary, score)
     select $1, story_id, article_id, role, position, 'approved', topic, reason, commentary, score
     from issue_items where issue_id = $2 and role = 'selected' and status in ('approved', 'pending')`,
    [id, source.id],
  );
  for (const email of TEST_EMAILS) {
    await query("insert into subscribers (email, status) values ($1, $2)", [email, email.includes("unsubscribed") ? "unsubscribed" : "active"]);
  }
  const after = new Date(sendTimeFor(TEST_WEEK).getTime() + 60_000);

  const notConfirmed = await sendIssue({ week: TEST_WEEK, now: after });
  check("refuses an unconfirmed issue", !notConfirmed.sent, String(notConfirmed.reason));

  await query("update issues set status = 'confirmed', confirmed_at = now() where id = $1", [id]);
  const early = await sendIssue({ week: TEST_WEEK, now: new Date(sendTimeFor(TEST_WEEK).getTime() - 60_000) });
  check("waits until Thursday 8 AM", !early.sent, String(early.reason));

  const run = await sendIssue({ week: TEST_WEEK, now: after });
  const deliveries = await query<{ email: string; status: string; message_id: string | null }>(
    "select s.email, d.status, d.message_id from deliveries d join subscribers s on s.id = d.subscriber_id where d.issue_id = $1",
    [id],
  );
  const [issue] = await query<{ status: string; html: string | null }>("select status, html from issues where id = $1", [id]);
  const ourDeliveries = deliveries.filter((d) => d.email.startsWith("dry-run-"));
  check("sends to every active subscriber", ourDeliveries.length === 3 && ourDeliveries.every((d) => d.status === "sent" && d.message_id), `${ourDeliveries.length} deliveries`);
  check("skips unsubscribed subscribers", !deliveries.some((d) => d.email.includes("unsubscribed")));
  check("marks the issue sent + stores the web version", issue.status === "sent" && !!issue.html?.includes("The Dispatch"), issue.status);
  check("reports completion", run.sent && run.complete === true);

  const again = await sendIssue({ week: TEST_WEEK, now: after });
  const [{ n }] = await query<{ n: number }>("select count(*)::int as n from deliveries where issue_id = $1", [id]);
  check("re-running never emails anyone twice", !again.sent && n === deliveries.length, String(again.reason));

  await cleanup();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll send checks passed (dry run, test data removed)");
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
