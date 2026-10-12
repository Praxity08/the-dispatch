"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import {
  endSession,
  isRubricUnlocked,
  lockRubricSession,
  passwordMatches,
  requireAdmin,
  rubricPasswordMatches,
  startSession,
  unlockRubricSession,
} from "@/lib/admin";
import { logEvent, query } from "@/lib/db";
import { finishRerank, refreshTotals, rerankIssue, rewriteCommentary } from "@/lib/draft";
import {
  addToBench,
  approveAll,
  confirmIssue,
  flagStory,
  getIssue,
  move,
  reopenIssue,
  type Result,
  saveCommentary,
  saveIssueText,
  setItemStatus,
  swapIn,
  undoSwap,
} from "@/lib/editor";
import { emailConfigured } from "@/lib/email";
import { addStoryFromLink } from "@/lib/manual";
import { resetDraft } from "@/lib/redraft";
import { sendTestEmail } from "@/lib/send";
import { CRITERION_KEYS, DEFAULT_RUBRIC, type Rubric } from "@/lib/rubric";
import { loadRubric, saveRubric } from "@/lib/rubric-store";
import { saveStyleGuide } from "@/lib/style";
import { addSubscriber, unsubscribe } from "@/lib/subscribers";
import { adminId } from "@/lib/telegram";
import { syncTelegram } from "@/lib/review";
import { latestIssue } from "@/lib/editor";
import { triggerJob } from "@/lib/trigger";
import { sendTimeFor } from "@/lib/week";

export type ActionState = Result | null;

export async function login(_: ActionState, formData: FormData): Promise<ActionState> {
  if (!passwordMatches(String(formData.get("password") ?? ""))) return { ok: false, message: "Wrong password." };
  await startSession();
  redirect("/admin");
}

export async function logout() {
  await endSession();
  redirect("/admin/login");
}

const num = (formData: FormData, key: string) => Number(formData.get(key));
const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");

/** Every editing button on the dashboard posts here with an `op`. Telegram is re-synced after changes. */
export async function editorAction(_: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  await loadRubric();
  const op = str(formData, "op");
  const issueId = num(formData, "issue");
  const itemId = num(formData, "item");
  let result: Result;

  try {
    switch (op) {
      case "approve":
        result = await setItemStatus(itemId, "approved");
        break;
      case "unapprove":
      case "restore":
        result = await setItemStatus(itemId, "pending");
        break;
      case "drop":
        result = await setItemStatus(itemId, "dropped");
        break;
      case "approve-all":
        result = await approveAll(issueId);
        break;
      case "commentary":
        result = await saveCommentary(itemId, str(formData, "commentary"));
        break;
      case "rewrite": {
        const issue = await getIssue(issueId);
        if (!issue || !["drafted", "in_review"].includes(issue.status)) {
          result = { ok: false, message: "The issue is locked. Reopen it to make changes." };
          break;
        }
        const { failures } = await rewriteCommentary(itemId, str(formData, "instruction").trim() || undefined);
        result = { ok: true, message: `Rewritten by Gemini. Review it before approving.${failures.length ? ` Heads-up: ${failures.join("; ")}.` : ""}` };
        break;
      }
      case "swap":
        result = await swapIn(itemId, num(formData, "bench"));
        break;
      case "undo-swap":
        result = await undoSwap(itemId);
        break;
      case "up":
      case "down":
        result = await move(itemId, op === "up" ? -1 : 1);
        break;
      case "add-to-bench":
        result = await addToBench(issueId, num(formData, "story"));
        break;
      case "add-link":
        result = await addStoryFromLink(str(formData, "url"), str(formData, "headline").trim() || undefined);
        break;
      case "pin":
      case "block":
      case "unflag":
        result = await flagStory(num(formData, "story"), op === "unflag" ? null : (op as "pin" | "block"));
        break;
      case "issue-text":
        result = await saveIssueText(issueId, str(formData, "subject"), str(formData, "intro"));
        break;
      case "confirm":
        result = await confirmIssue(issueId, adminId(), "dashboard");
        break;
      case "reopen":
        result = await reopenIssue(issueId);
        break;
      case "rerank":
        result = await rerankIssue(issueId);
        // New stories get commentary and Telegram is updated once that's done, after we respond.
        if (result.ok) after(() => finishRerank(issueId).catch((err) => console.error("rerank finish failed", err)));
        revalidatePath("/admin");
        return result;
      case "redraft":
        result = await resetDraft(issueId);
        if (result.ok) await triggerJob("/api/cron/draft");
        // The old Telegram messages are already retired; nothing to sync.
        revalidatePath("/admin");
        return result;
      case "send-now": {
        // Only after confirmation, and only once the scheduled slot has passed (otherwise the schedule handles it).
        const issue = await getIssue(issueId);
        if (issue?.status !== "confirmed") result = { ok: false, message: "Confirm the issue first." };
        else if (Date.now() < sendTimeFor(issue.week_start).getTime()) result = { ok: false, message: "It's scheduled; it will go out automatically." };
        else {
          await logEvent("send_now_requested", { via: "dashboard" }, issueId);
          await triggerJob("/api/cron/send");
          result = { ok: true, message: "Sending now. Refresh in a minute to watch progress." };
        }
        break;
      }
      case "test-email":
        if (!emailConfigured()) result = { ok: false, message: "Gmail isn't configured yet (app password missing)." };
        else result = { ok: true, message: `Test email sent to ${(await sendTestEmail(issueId)).to}. Only you got it.` };
        break;
      default:
        result = { ok: false, message: "Unknown action." };
    }
  } catch (err) {
    console.error("editor action failed", op, err);
    const message = (err as Error).message ?? String(err);
    result = { ok: false, message: /quota|Gemini|All Gemini/i.test(message) ? "Gemini is busy or out of free quota. Try again later, or edit by hand." : message };
  }

  // Telegram re-renders ~10 messages; do it after responding so the dashboard stays instant.
  if (result.ok && issueId) after(() => syncTelegram(issueId).catch((err) => console.error("telegram sync failed", err)));
  revalidatePath("/admin");
  return result;
}

const JOBS: Record<string, { path: string; label: string }> = {
  ingest: { path: "/api/cron/ingest", label: "Fetching new articles" },
  draft: { path: "/api/cron/draft", label: "Drafting this week's issue" },
  deliver: { path: "/api/cron/deliver", label: "Posting the draft to Telegram" },
  remind: { path: "/api/cron/remind", label: "Sending the Telegram reminder" },
  score: { path: "/api/cron/score", label: "Scoring new stories" },
  bounces: { path: "/api/cron/bounces", label: "Checking the inbox for replies, bounces and unsubscribes" },
  "early-look": { path: "/api/cron/early-look?force=1", label: "Fetching today's news and posting the early look to Telegram" },
};

/** Starts a pipeline step in its own function invocation. Emailing subscribers is deliberately not here. */
export async function runJob(_: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const job = JOBS[str(formData, "job")];
  if (!job) return { ok: false, message: "Unknown job." };
  await logEvent("manual_run", { job: job.label });
  await triggerJob(job.path);
  revalidatePath("/admin");
  return { ok: true, message: `${job.label}… refresh in a minute to see the results.` };
}

export async function updateStyleGuide(_: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const guide = str(formData, "guide").trim();
  if (guide.length < 200) return { ok: false, message: "The guide looks too short to save." };
  await saveStyleGuide(guide);
  revalidatePath("/admin");
  return { ok: true, message: "Voice guide saved. The next draft and every rewrite use it." };
}

export async function subscriberAction(_: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const op = str(formData, "op");
  let result: Result;
  if (op === "add") result = await addSubscriber(str(formData, "email"), str(formData, "name"));
  else if (op === "unsubscribe") result = (await unsubscribe(num(formData, "id"), "dashboard")) ? { ok: true, message: "Unsubscribed." } : { ok: false, message: "Already unsubscribed." };
  else if (op === "reactivate") {
    const [row] = await query<{ email: string }>("select email from subscribers where id = $1", [num(formData, "id")]);
    result = row ? await addSubscriber(row.email) : { ok: false, message: "Not found." };
  } else result = { ok: false, message: "Unknown action." };
  revalidatePath("/admin");
  return result;
}

/** Reader replies: mark read / unread, archive / restore. */
export async function replyAction(_: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const next = { read: "read", unread: "new", archive: "archived", unarchive: "read" }[str(formData, "op")];
  if (!next) return { ok: false, message: "Unknown action." };
  const id = num(formData, "id");
  const rows = id
    ? await query("update reader_replies set status = $2 where id = $1 returning id", [id, next])
    : await query("update reader_replies set status = 'read' where status = 'new' returning id"); // "mark all read"
  revalidatePath("/admin");
  return rows.length ? { ok: true, message: "Done." } : { ok: false, message: "Nothing to update." };
}

export async function toggleSource(formData: FormData) {
  await requireAdmin();
  await query("update sources set active = not active where id = $1", [Number(formData.get("id"))]);
  revalidatePath("/admin");
}

// ---------------------------------------------------------------- scoring rubric (second password)

const MAX_FAILED_UNLOCKS = 5;

export async function unlockRubric(_: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const [{ failed }] = await query<{ failed: number }>(
    "select count(*)::int as failed from events where kind = 'rubric_unlock_failed' and created_at > now() - interval '15 minutes'",
  );
  if (failed >= MAX_FAILED_UNLOCKS) return { ok: false, message: "Too many wrong attempts. Try again in 15 minutes." };
  if (!rubricPasswordMatches(str(formData, "password"))) {
    await logEvent("rubric_unlock_failed", {});
    return { ok: false, message: "Wrong rubric password." };
  }
  await unlockRubricSession();
  await logEvent("rubric_unlocked", {});
  revalidatePath("/admin");
  return { ok: true, message: "Unlocked." };
}

export async function lockRubric() {
  await requireAdmin();
  await lockRubricSession();
  revalidatePath("/admin");
}

function parseRubric(formData: FormData): Rubric {
  const criteria = {} as Rubric["criteria"];
  for (const k of CRITERION_KEYS) {
    criteria[k] = {
      weight: Number(formData.get(`w_${k}`)) / 100,
      question: str(formData, `q_${k}`).trim(),
      why: str(formData, `why_${k}`).trim(),
      anchors: { 0: str(formData, `a0_${k}`).trim(), 3: str(formData, `a3_${k}`).trim(), 5: str(formData, `a5_${k}`).trim() },
    };
  }
  const n = (key: string) => Number(formData.get(key));
  return {
    criteria,
    weakSourcingPenalty: n("penalty"),
    selection: {
      min: n("sel_min"),
      max: n("sel_max"),
      target: n("sel_target"),
      minTopics: n("sel_minTopics"),
      maxPerTopic: n("sel_maxPerTopic"),
      maxPerCompany: n("sel_maxPerCompany"),
      shortlist: n("sel_shortlist"),
      bench: n("sel_bench"),
      lookbackIssues: n("sel_lookbackIssues"),
    },
    commentary: {
      minSentences: n("com_minSentences"),
      maxSentences: n("com_maxSentences"),
      minWords: n("com_minWords"),
      maxWords: n("com_maxWords"),
      minReviewAverage: n("com_minReviewAverage"),
    },
  };
}

async function applyNewRubric(rubric: Rubric, note: string): Promise<ActionState> {
  const errors = await saveRubric(rubric, note);
  if (errors.length) return { ok: false, message: errors.join(" ") };
  // Re-rank this week with the new weights (no Gemini calls) and refresh Telegram's scores.
  const { updated } = await refreshTotals();
  const issue = await latestIssue();
  if (issue) after(() => syncTelegram(issue.id).catch((err) => console.error("telegram sync failed", err)));
  revalidatePath("/admin");
  return {
    ok: true,
    message: `Saved. ${updated} stories re-scored with the new weights. Your lineup hasn't changed: open This week's issue to re-rank it from the pool. Wording changes apply the next time stories are scored.`,
  };
}

export async function saveRubricAction(_: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  if (!(await isRubricUnlocked())) return { ok: false, message: "The rubric is locked. Unlock it with the rubric password first." };
  return applyNewRubric(parseRubric(formData), str(formData, "note"));
}

export async function restoreDefaultRubric(_: ActionState): Promise<ActionState> {
  await requireAdmin();
  if (!(await isRubricUnlocked())) return { ok: false, message: "The rubric is locked. Unlock it with the rubric password first." };
  return applyNewRubric(DEFAULT_RUBRIC, "Restored the default rubric");
}
