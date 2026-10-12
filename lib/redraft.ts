// "Start over with a fresh draft": clears this week's lineup and re-runs the editorial pass.
import { logEvent, query } from "./db";
import type { Result } from "./editor";
import { chatId, editHtml, sendHtml, tg } from "./telegram";

export async function resetDraft(issueId: number): Promise<Result> {
  const [issue] = await query<{ id: number; issue_number: number; status: string; delivered_at: string | null; telegram_control_message_id: number | null }>(
    "select id, issue_number, status, delivered_at, telegram_control_message_id from issues where id = $1",
    [issueId],
  );
  if (!issue) return { ok: false, message: "Issue not found." };
  if (!["drafted", "in_review"].includes(issue.status)) {
    return { ok: false, message: issue.status === "confirmed" ? "Reopen the issue first: a confirmed issue can't be redrafted." : `The issue is ${issue.status}.` };
  }

  // Switch off the old review messages in Telegram so nobody taps a stale button.
  const old = await query<{ telegram_message_id: number }>(
    "select telegram_message_id from issue_items where issue_id = $1 and telegram_message_id is not null",
    [issueId],
  );
  for (const m of old) {
    await tg("editMessageReplyMarkup", { chat_id: chatId(), message_id: Number(m.telegram_message_id), reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
  if (issue.telegram_control_message_id) {
    await editHtml(Number(issue.telegram_control_message_id), `♻️ <b>This draft of #${issue.issue_number} was replaced.</b> A fresh draft is on its way.`).catch(() => {});
  }

  // Claim the reset atomically, then clear the lineup and draft text.
  const [claimed] = await query(
    `update issues set status = 'collecting', subject = null, intro = null, html = null, selection_log = null,
            drafted_at = null, delivered_at = null, reminder_sent_at = null,
            telegram_header_message_id = null, telegram_control_message_id = null, redeliver = $2
     where id = $1 and status in ('drafted', 'in_review') returning id`,
    [issueId, !!issue.delivered_at],
  );
  if (!claimed) return { ok: false, message: "The issue changed a moment ago; refresh and try again." };
  await query("delete from issue_items where issue_id = $1", [issueId]);
  await logEvent("redraft_started", { wasDelivered: !!issue.delivered_at }, issueId);
  if (issue.delivered_at) {
    await sendHtml(`♻️ Shreya started a fresh draft of #${issue.issue_number} from the dashboard. The new one will appear here when it's ready.`).catch(() => {});
  }
  return { ok: true, message: "Starting a fresh draft. Scoring, selection and commentary take a few minutes; refresh to follow along." };
}
