// Tests "Start over with a fresh draft" on a throwaway copy of the latest issue (no Gemini, no Telegram).
//   npx tsx --env-file=.env.local scripts/e2e-redraft.ts
import { query } from "../lib/db";
import { resetDraft } from "../lib/redraft";

const TEST_WEEK = "2026-09-21";
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const cleanup = () => query("delete from issues where week_start = $1", [TEST_WEEK]);

async function main() {
  await cleanup();
  const [source] = await query<{ id: number }>("select id from issues where week_start <> $1 order by week_start desc limit 1", [TEST_WEEK]);
  const [copy] = await query<{ id: number }>(
    `insert into issues (week_start, issue_number, status, subject, intro, drafted_at)
     select $1, issue_number, 'confirmed', subject, intro, now() from issues where id = $2 returning id`,
    [TEST_WEEK, source.id],
  );
  const id = Number(copy.id);
  await query(
    `insert into issue_items (issue_id, story_id, article_id, role, position, status, topic, commentary)
     select $1, story_id, article_id, role, position, status, topic, commentary from issue_items where issue_id = $2`,
    [id, source.id],
  );

  const blocked = await resetDraft(id);
  check("refuses while confirmed", !blocked.ok, blocked.message);

  await query("update issues set status = 'in_review' where id = $1", [id]);
  const r = await resetDraft(id);
  const [issue] = await query<{ status: string; subject: string | null; redeliver: boolean }>("select status, subject, redeliver from issues where id = $1", [id]);
  const [{ n }] = await query<{ n: number }>("select count(*)::int as n from issue_items where issue_id = $1", [id]);
  check("resets the issue for a fresh draft", r.ok && issue.status === "collecting" && issue.subject === null && n === 0, `status=${issue.status} items=${n}`);
  check("not re-posted to Telegram (was never delivered)", issue.redeliver === false);

  const again = await resetDraft(id);
  check("can't reset twice", !again.ok, again.message);

  await cleanup();
  const [{ left }] = await query<{ left: number }>("select count(*)::int as left from issues where week_start = $1", [TEST_WEEK]);
  console.log(failures ? `\n${failures} failed` : `\nAll redraft checks passed (test issue removed: ${left === 0})`);
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await cleanup();
  process.exit(1);
});
