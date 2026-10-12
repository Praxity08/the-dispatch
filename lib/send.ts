// Thursday send. The one hard rule: an issue is only ever emailed to subscribers if Shreya confirmed it
// in Telegram (status 'confirmed'). There is no other path to 'sending'.
import { logEvent, query } from "./db";
import { dryRun, emailConfigured, type EmailProvider, emailProvider, loadEmailIssue, PROVIDER_INFO, renderHtml, renderText, resendTestMode, sendBatchSize, sendEmail, sendEmails } from "./email";
import { appUrl, requireEnv } from "./env";
import { oneClickUnsubscribeUrl, unsubscribePageUrl } from "./subscribers";
import { esc, sendHtml } from "./telegram";
import { formatIst, sendTimeFor, weekStart } from "./week";


type IssueRow = { id: number; issue_number: number; week_start: string; status: string };

export function issueWebUrl(issueId: number): string {
  return `${appUrl()}/issues/${issueId}`;
}

/**
 * Sends the week's confirmed issue to every active subscriber. Resumable and idempotent:
 * one `deliveries` row per (issue, subscriber), so re-runs never email anyone twice.
 */
export async function sendIssue({ budgetMs = Infinity, week = weekStart(), now = new Date() } = {}) {
  const deadline = Date.now() + budgetMs;
  const [issue] = await query<IssueRow>("select id, issue_number, week_start::text, status from issues where week_start = $1", [week]);
  if (!issue) return { sent: false, complete: true, reason: "no issue this week" };
  if (issue.status === "sent") return { sent: false, complete: true, reason: "already sent" };
  if (issue.status !== "confirmed" && issue.status !== "sending") {
    await logEvent("send_refused", { status: issue.status }, issue.id);
    return { sent: false, complete: true, reason: `not confirmed by Shreya (status: ${issue.status})` };
  }
  if (issue.status === "confirmed" && now < sendTimeFor(week)) {
    return { sent: false, complete: true, reason: `scheduled for ${formatIst(sendTimeFor(week))}` };
  }
  if (!emailConfigured()) return { sent: false, complete: true, reason: `${PROVIDER_INFO[emailProvider()].label} is not configured` };

  // Claim: confirmed → sending happens exactly once.
  if (issue.status === "confirmed") {
    const [claimed] = await query("update issues set status = 'sending' where id = $1 and status = 'confirmed' returning id", [issue.id]);
    if (!claimed) return { sent: false, complete: false, reason: "another run claimed this issue" };
    const content = await loadEmailIssue(issue.id);
    const web = renderHtml(content, { unsubscribeUrl: `${appUrl()}/#subscribe` });
    await query("update issues set html = $2 where id = $1", [issue.id, web]);
    await logEvent("sending_started", { stories: content.stories.length }, issue.id);
  }

  // Everyone active right now gets a delivery row (no-op for rows that already exist).
  await query(
    `insert into deliveries (issue_id, subscriber_id) select $1, id from subscribers where status = 'active' and not is_sample
     on conflict (issue_id, subscriber_id) do nothing`,
    [issue.id],
  );

  const content = await loadEmailIssue(issue.id);
  const webUrl = issueWebUrl(issue.id);
  let sent = 0;
  let failed = 0;
  let quotaHit = false;

  while (Date.now() < deadline && !quotaHit) {
    const batch = await query<{ delivery_id: number; subscriber_id: number; email: string; status: string }>(
      `select d.id as delivery_id, s.id as subscriber_id, s.email, s.status
       from deliveries d join subscribers s on s.id = d.subscriber_id
       where d.issue_id = $1 and d.status = 'queued' order by d.id limit $2`,
      [issue.id, sendBatchSize()],
    );
    if (batch.length === 0) break;

    // Someone who unsubscribed or bounced after the send started is skipped.
    const inactive = batch.filter((d) => d.status !== "active");
    for (const d of inactive) {
      await query("update deliveries set status = 'failed', error = $2 where id = $1", [d.delivery_id, `subscriber ${d.status}`]);
    }
    const active = batch.filter((d) => d.status === "active");
    if (!active.length) continue;

    // Each subscriber gets their own unsubscribe links; the provider sends the batch in one go where it can.
    const outcomes = await sendEmails(
      active.map((d) => {
        const links = { unsubscribeUrl: unsubscribePageUrl(Number(d.subscriber_id)), webUrl };
        return {
          to: d.email,
          subject: content.subject,
          html: renderHtml(content, links),
          text: renderText(content, links),
          oneClickUrl: oneClickUnsubscribeUrl(Number(d.subscriber_id)),
        };
      }),
      { idempotencyKey: `dispatch-${issue.id}-${active[0].delivery_id}-${active.length}` },
    );
    for (const [i, d] of active.entries()) {
      const o = outcomes[i];
      if (!o) break;
      if (o.ok) {
        await query("update deliveries set status = 'sent', message_id = $2, sent_at = now() where id = $1", [d.delivery_id, o.id]);
        sent++;
      } else if (o.quota) {
        quotaHit = true; // daily allowance used up: the rest stay queued for the next run
      } else {
        await query("update deliveries set status = 'failed', error = $2 where id = $1", [d.delivery_id, o.error.slice(0, 500)]);
        failed++;
      }
    }
  }

  const [{ queued }] = await query<{ queued: number }>(
    "select count(*)::int as queued from deliveries where issue_id = $1 and status = 'queued'",
    [issue.id],
  );
  if (queued === 0) {
    const [done] = await query("update issues set status = 'sent', sent_at = now() where id = $1 and status = 'sending' returning id", [issue.id]);
    if (done) {
      const [totals] = await query<{ sent: number; failed: number }>(
        `select count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'failed')::int as failed
         from deliveries where issue_id = $1`,
        [issue.id],
      );
      await logEvent("sent", { ...totals, dryRun: dryRun() }, issue.id);
      if (!dryRun()) await sendHtml(
        `✅ <b>The Dispatch #${issue.issue_number} is out.</b> Delivered to ${totals.sent} subscribers${totals.failed ? `, ${totals.failed} failed` : ""}.\n<a href="${esc(webUrl)}">View it in the browser</a>`,
      ).catch(() => {});
    }
  } else if (quotaHit) {
    await sendHtml(`⚠️ ${PROVIDER_INFO[emailProvider()].label}'s sending limit was reached for #${issue.issue_number}. ${queued} emails are queued and will go out on the next run.`).catch(() => {});
  }
  return { sent: true, complete: queued === 0, issue: issue.id, sentNow: sent, failedNow: failed, queued, quotaHit };
}

/** Sends the current draft to the newsletter's own inbox only. Never touches subscribers or the issue status. */
export async function sendTestEmail(issueId: number, to?: string, provider: EmailProvider = emailProvider()) {
  // "Send to me" through Resend's test mode goes to the Resend account's own address (the only one it reaches).
  to ??= provider === "resend" && resendTestMode() && process.env.RESEND_TEST_TO ? process.env.RESEND_TEST_TO : requireEnv("GMAIL_USER");
  const content = await loadEmailIssue(issueId);
  // The preview link needs the editor login, so only the newsletter's own inbox gets it.
  const own = to.toLowerCase() === requireEnv("GMAIL_USER").toLowerCase();
  const links = { unsubscribeUrl: `${appUrl()}/unsubscribe?test=1`, webUrl: own ? `${appUrl()}/admin/preview` : undefined };
  const messageId = await sendEmail({
    to,
    subject: `[TEST] ${content.subject}`,
    html: renderHtml(content, links),
    text: renderText(content, links),
  }, provider);
  await logEvent("test_email_sent", { to, provider }, issueId);
  return { to, messageId };
}
