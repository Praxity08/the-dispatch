// Shreya's editing operations on the week's issue. Used by both the dashboard and the Telegram bot,
// so the two always follow the same rules. Each returns { ok, message } and never sends email.
import { logEvent, query } from "./db";
import { checkCommentary, type CriterionScores, SELECTION, underReportedScore } from "./rubric";
import { normalizePublisher } from "./text";
import { TOPICS, type Topic } from "./topics";
import { weekStart } from "./week";

export type Result = { ok: boolean; message: string };
export type ItemStatus = "pending" | "approved" | "dropped" | "swapped_out";

export type EditorIssue = {
  id: number;
  issue_number: number;
  week_start: string;
  status: string;
  subject: string | null;
  intro: string | null;
  drafted_at: string | null;
  delivered_at: string | null;
  reminder_sent_at: string | null;
  confirmed_at: string | null;
  sent_at: string | null;
  telegram_control_message_id: number | null;
};

export type EditorItem = {
  id: number;
  story_id: number;
  role: "selected" | "bench";
  status: ItemStatus;
  position: number;
  topic: Topic;
  score: number | null;
  reason: string | null;
  commentary: string;
  original_commentary: string | null;
  flagged: boolean;
  edited_by_shreya: boolean;
  checks: { problems?: string[]; review?: { angle: number; voice: number; grounded: number; forwardable: number; note: string } } | null;
  headline: string;
  url: string;
  publisher: string;
  company: string | null;
  publishers: string[];
  swapped_for: number | null;
  gemini: (Omit<CriterionScores, "under_reported"> & { connects_to?: number }) | null;
  criteria: CriterionScores | null;
};

const ISSUE_COLUMNS = `id, issue_number, week_start::text, status, subject, intro, drafted_at, delivered_at, reminder_sent_at,
  confirmed_at, sent_at, telegram_control_message_id`;

/** Statuses in which Shreya can still change the lineup. */
export const EDITABLE = ["drafted", "in_review"];

export async function latestIssue(): Promise<EditorIssue | undefined> {
  const [issue] = await query<EditorIssue>(`select ${ISSUE_COLUMNS} from issues order by week_start desc limit 1`);
  return issue;
}

export async function getIssue(id: number): Promise<EditorIssue | undefined> {
  const [issue] = await query<EditorIssue>(`select ${ISSUE_COLUMNS} from issues where id = $1`, [id]);
  return issue;
}

export async function loadEditorItems(issueId: number): Promise<EditorItem[]> {
  const rows = await query<Omit<EditorItem, "criteria">>(
    `select ii.id, ii.story_id, ii.role, ii.status, ii.position, ii.topic, ii.score, ii.reason, coalesce(ii.commentary, '') as commentary,
            ii.original_commentary, ii.flagged, ii.edited_by_shreya, ii.checks, ii.swapped_for, s.headline, a.url, a.publisher, s.company,
            s.scores as gemini,
            (select array_agg(distinct x.publisher) from articles x where x.story_id = ii.story_id) as publishers
     from issue_items ii join stories s on s.id = ii.story_id join articles a on a.id = ii.article_id
     where ii.issue_id = $1 order by ii.role desc, ii.position, ii.id`,
    [issueId],
  );
  return rows.map((r) => {
    const outlets = new Set((r.publishers ?? []).map(normalizePublisher)).size;
    const g = r.gemini;
    return {
      ...r,
      id: Number(r.id),
      story_id: Number(r.story_id),
      criteria: g
        ? { signal: g.signal, counterintuitive: g.counterintuitive, under_reported: underReportedScore(outlets), connects: g.connects, india: g.india, commentary_potential: g.commentary_potential }
        : null,
    };
  });
}

type LineupLike = { role: string; status: string; topic: string; company: string | null };

export const isLive = (i: { role: string; status: string }) => i.role === "selected" && (i.status === "pending" || i.status === "approved");

/** The hard selection rules, applied to the lineup as it stands. Empty = OK. */
export function lineupProblems(items: LineupLike[]): string[] {
  const live = items.filter(isLive);
  const problems: string[] = [];
  if (live.length < SELECTION.min || live.length > SELECTION.max) problems.push(`${live.length} stories (needs ${SELECTION.min}–${SELECTION.max})`);
  const perTopic = new Map<string, number>();
  for (const i of live) perTopic.set(i.topic, (perTopic.get(i.topic) ?? 0) + 1);
  if (perTopic.size < SELECTION.minTopics) problems.push(`only ${perTopic.size} topics (needs ${SELECTION.minTopics}+)`);
  for (const [t, n] of perTopic) if (n > SELECTION.maxPerTopic) problems.push(`${n} stories in ${TOPICS[t as Topic] ?? t} (max ${SELECTION.maxPerTopic})`);
  const key = (c: string | null) => (c ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const seen = new Map<string, number>();
  for (const i of live) if (key(i.company)) seen.set(key(i.company), (seen.get(key(i.company)) ?? 0) + 1);
  for (const [, n] of seen) if (n > SELECTION.maxPerCompany) problems.push("two stories about the same company");
  return problems;
}

/** What still stands between the draft and "Confirm". */
export function readiness(issue: EditorIssue, items: EditorItem[]) {
  const live = items.filter(isLive);
  const pending = live.filter((i) => i.status === "pending");
  const empty = live.filter((i) => !i.commentary.trim());
  const flagged = live.filter((i) => i.flagged && !i.edited_by_shreya);
  const rules = lineupProblems(items);
  const checklist = [
    { label: `Every story approved`, ok: pending.length === 0, detail: pending.length ? `${pending.length} pending` : `${live.length} approved` },
    {
      label: `Lineup rules (${SELECTION.min}–${SELECTION.max} stories, ${SELECTION.minTopics}+ topics, ≤${SELECTION.maxPerTopic} per topic, ${SELECTION.maxPerCompany} per company)`,
      ok: rules.length === 0,
      detail: rules.join("; ") || "all met",
    },
    { label: "Every story has commentary", ok: empty.length === 0, detail: empty.length ? `#${empty.map((i) => i.position).join(", #")} empty` : "yes" },
    { label: "Subject line and opening written", ok: !!issue.subject?.trim() && !!issue.intro?.trim(), detail: "" },
  ];
  return { checklist, ready: checklist.every((c) => c.ok), flagged: flagged.length, live: live.length };
}

// ---------------------------------------------------------------- operations

async function issueForItem(itemId: number): Promise<{ issue: EditorIssue; item: EditorItem } | Result> {
  const [row] = await query<{ issue_id: number }>("select issue_id from issue_items where id = $1", [itemId]);
  if (!row) return { ok: false, message: "Story not found." };
  const issue = (await getIssue(Number(row.issue_id)))!;
  if (!EDITABLE.includes(issue.status)) {
    return { ok: false, message: issue.status === "confirmed" ? "The issue is confirmed and locked. Reopen it to make changes." : `The issue is ${issue.status}.` };
  }
  const item = (await loadEditorItems(issue.id)).find((i) => i.id === itemId)!;
  return { issue, item };
}

export async function setItemStatus(itemId: number, status: "pending" | "approved" | "dropped"): Promise<Result> {
  const ctx = await issueForItem(itemId);
  if ("ok" in ctx) return ctx;
  const { item } = ctx;
  if (item.role !== "selected" || item.status === "swapped_out") return { ok: false, message: "That story isn't in the lineup." };
  if (status !== "dropped" && item.status === "dropped" && !item.commentary.trim()) return { ok: false, message: "Write commentary before restoring it." };
  await query("update issue_items set status = $2, updated_at = now() where id = $1", [itemId, status]);
  return { ok: true, message: { pending: "Back to pending.", approved: "Approved.", dropped: "Dropped from this issue." }[status] };
}

export async function approveAll(issueId: number): Promise<Result> {
  const issue = await getIssue(issueId);
  if (!issue || !EDITABLE.includes(issue.status)) return { ok: false, message: `The issue is ${issue?.status ?? "missing"}.` };
  const rows = await query(
    "update issue_items set status = 'approved', updated_at = now() where issue_id = $1 and role = 'selected' and status = 'pending' and coalesce(commentary, '') <> '' returning id",
    [issueId],
  );
  return { ok: true, message: rows.length ? `Approved ${rows.length} stories.` : "Nothing was pending." };
}

/** Shreya's own words: saved as-is and approved. Rule checks are returned as a heads-up only. */
export async function saveCommentary(itemId: number, text: string): Promise<Result> {
  const ctx = await issueForItem(itemId);
  if ("ok" in ctx) return ctx;
  const commentary = text.trim();
  if (!commentary) return { ok: false, message: "Commentary can't be empty." };
  const checks = checkCommentary(commentary, ctx.item.headline);
  await query(
    `update issue_items set commentary = $2, edited_by_shreya = true, flagged = false,
            status = case when role = 'selected' and status in ('pending', 'approved') then 'approved' else status end,
            -- Keep the AI version she replaced (not her own earlier wording): drafts learn from the difference.
            checks = coalesce(checks, '{}'::jsonb) || $3::jsonb
                     || case when edited_by_shreya or coalesce(commentary, '') = '' then '{}'::jsonb else jsonb_build_object('ai_version', commentary) end,
            updated_at = now()
     where id = $1`,
    [itemId, commentary, JSON.stringify({ ...checks, problems: [], edited_by_shreya: true })],
  );
  await logEvent("edited", { item: itemId }, ctx.issue.id);
  const note = checks.failures.length ? ` Heads-up (your call): ${checks.failures.join("; ")}.` : "";
  return { ok: true, message: `Saved${ctx.item.role === "selected" ? " and approved" : ""}.${note}` };
}

export async function swapIn(outItemId: number, benchItemId: number): Promise<Result> {
  const ctx = await issueForItem(outItemId);
  if ("ok" in ctx) return ctx;
  const items = await loadEditorItems(ctx.issue.id);
  const out = items.find((i) => i.id === outItemId);
  const incoming = items.find((i) => i.id === benchItemId);
  if (!out || !isLive(out)) return { ok: false, message: "That story is no longer in the lineup." };
  if (!incoming || incoming.role !== "bench" || incoming.status !== "pending") return { ok: false, message: "That bench story isn't available." };
  if (!incoming.commentary.trim()) return { ok: false, message: "That bench story has no commentary yet. Write some first." };

  const after = items.map((i) => (i.id === out.id ? { ...i, status: "swapped_out" as const } : i.id === incoming.id ? { ...i, role: "selected" as const } : i));
  const problems = lineupProblems(after);
  if (problems.length) return { ok: false, message: `That swap breaks the lineup rules: ${problems.join("; ")}.` };

  await query("update issue_items set status = 'swapped_out', swapped_for = $2, updated_at = now() where id = $1", [out.id, incoming.id]);
  await query("update issue_items set role = 'selected', position = $2, status = 'pending', updated_at = now() where id = $1", [incoming.id, out.position]);
  await logEvent("swapped", { out: out.id, in: incoming.id }, ctx.issue.id);
  return { ok: true, message: `Swapped in “${incoming.headline}” at #${out.position}.` };
}

/** Reverses a swap: the swapped-out story returns to its place and the swapped-in one goes back to the bench. */
export async function undoSwap(outItemId: number): Promise<Result> {
  const ctx = await issueForItem(outItemId);
  if ("ok" in ctx) return ctx;
  const items = await loadEditorItems(ctx.issue.id);
  const out = items.find((i) => i.id === outItemId);
  const [row] = await query<{ swapped_for: number | null }>("select swapped_for from issue_items where id = $1", [outItemId]);
  const incoming = items.find((i) => i.id === Number(row?.swapped_for));
  if (!out || out.status !== "swapped_out" || !incoming) return { ok: false, message: "That swap can't be undone." };
  if (!isLive(incoming)) return { ok: false, message: "The story that replaced it has since been dropped or swapped; restore it from there instead." };

  const after = items.map((i) => (i.id === out.id ? { ...i, status: "pending" as const } : i.id === incoming.id ? { ...i, role: "bench" as const } : i));
  const problems = lineupProblems(after);
  if (problems.length) return { ok: false, message: `Undoing it would break the lineup rules: ${problems.join("; ")}.` };

  const [{ next }] = await query<{ next: number }>(
    "select coalesce(max(position), 0) + 1 as next from issue_items where issue_id = $1 and role = 'bench'",
    [ctx.issue.id],
  );
  await query("update issue_items set role = 'bench', status = 'pending', position = $2, updated_at = now() where id = $1", [incoming.id, next]);
  await query("update issue_items set status = 'pending', swapped_for = null, position = $2, updated_at = now() where id = $1", [out.id, incoming.position]);
  await logEvent("swap_undone", { restored: out.id, benched: incoming.id }, ctx.issue.id);
  return { ok: true, message: `Undone: “${out.headline}” is back at #${incoming.position} (pending), and the other story is on the bench again.` };
}

/** Moves a live story up or down the running order. */
export async function move(itemId: number, direction: -1 | 1): Promise<Result> {
  const ctx = await issueForItem(itemId);
  if ("ok" in ctx) return ctx;
  const live = (await loadEditorItems(ctx.issue.id)).filter(isLive).sort((a, b) => a.position - b.position);
  const idx = live.findIndex((i) => i.id === itemId);
  const other = live[idx + direction];
  if (idx < 0 || !other) return { ok: false, message: "It's already at the end." };
  await query("update issue_items set position = $2 where id = $1", [live[idx].id, other.position]);
  await query("update issue_items set position = $2 where id = $1", [other.id, live[idx].position]);
  return { ok: true, message: "Moved." };
}

/** Puts any story from this week's pool on the bench (to be written and swapped in). */
export async function addToBench(issueId: number, storyId: number): Promise<Result> {
  const issue = await getIssue(issueId);
  if (!issue || !EDITABLE.includes(issue.status)) return { ok: false, message: `The issue is ${issue?.status ?? "missing"}.` };
  const [article] = await query<{ id: number; topic: Topic }>(
    `select a.id, coalesce(s.topic, a.topic) as topic from articles a join stories s on s.id = a.story_id
     where a.story_id = $1 order by (a.url like 'https://news.google.com/%'), a.id limit 1`,
    [storyId],
  );
  if (!article) return { ok: false, message: "Story not found." };
  const [{ next }] = await query<{ next: number }>("select coalesce(max(position), 0) + 1 as next from issue_items where issue_id = $1 and role = 'bench'", [issueId]);
  const rows = await query(
    `insert into issue_items (issue_id, story_id, article_id, role, position, topic, reason, score)
     select $1, s.id, $3, 'bench', $4, $5, coalesce(s.scores->>'reason', 'Added by Shreya'), s.score from stories s where s.id = $2
     on conflict (issue_id, story_id) do nothing returning id`,
    [issueId, storyId, article.id, next, article.topic],
  );
  if (!rows.length) return { ok: false, message: "That story is already in this issue." };
  await logEvent("added_to_bench", { story: storyId }, issueId);
  return { ok: true, message: "Added to the bench. Write its commentary, then swap it in." };
}

export async function saveIssueText(issueId: number, subject: string, intro: string): Promise<Result> {
  const issue = await getIssue(issueId);
  if (!issue || !EDITABLE.includes(issue.status)) return { ok: false, message: `The issue is ${issue?.status ?? "missing"}.` };
  if (!subject.trim() || !intro.trim()) return { ok: false, message: "Subject and opening can't be empty." };
  await query("update issues set subject = $2, intro = $3 where id = $1", [issueId, subject.trim().slice(0, 200), intro.trim()]);
  return { ok: true, message: "Subject and opening saved." };
}

/** Shreya's explicit confirmation. The only way an issue becomes sendable. */
export async function confirmIssue(issueId: number, by: number, via: "telegram" | "dashboard"): Promise<Result> {
  const issue = await getIssue(issueId);
  if (!issue) return { ok: false, message: "Issue not found." };
  if (!EDITABLE.includes(issue.status)) return { ok: false, message: `Already ${issue.status}.` };
  const { checklist, ready } = readiness(issue, await loadEditorItems(issueId));
  if (!ready) return { ok: false, message: `Not ready: ${checklist.filter((c) => !c.ok).map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ""}`).join("; ")}.` };
  const rows = await query(
    "update issues set status = 'confirmed', confirmed_at = now(), confirmed_by = $2 where id = $1 and status = any($3::text[]) returning id",
    [issueId, by, EDITABLE],
  );
  if (!rows.length) return { ok: false, message: "It was confirmed a moment ago." };
  await logEvent("confirmed", { by, via }, issueId);
  return { ok: true, message: "Confirmed." };
}

export async function reopenIssue(issueId: number): Promise<Result> {
  const rows = await query(
    "update issues set status = 'in_review', confirmed_at = null, confirmed_by = null where id = $1 and status = 'confirmed' returning id",
    [issueId],
  );
  if (!rows.length) return { ok: false, message: "Only a confirmed issue that hasn't started sending can be reopened." };
  await logEvent("reopened", {}, issueId);
  return { ok: true, message: "Reopened for edits. Confirm again when you're done." };
}

/** Early-look calls before the draft: "pin" = must be in Wednesday's pick, "block" = never, null = the rubric decides. */
export async function flagStory(storyId: number, flag: "pin" | "block" | null): Promise<Result> {
  const rows = await query("update stories set editor_flag = $2 where id = $1 returning id", [storyId, flag]);
  if (!rows.length) return { ok: false, message: "Story not found." };
  await logEvent("story_flagged", { story: storyId, flag });
  const [issue] = await query<{ status: string }>("select status from issues where week_start = $1", [weekStart()]);
  const drafted = issue && issue.status !== "collecting";
  const later = drafted && flag ? " The draft already exists, so this applies if you start over or next time." : "";
  return {
    ok: true,
    message: (flag === "pin" ? "Pinned: it will be in Wednesday's draft." : flag === "block" ? "Blocked: it won't be picked." : "Cleared: the rubric decides.") + later,
  };
}
