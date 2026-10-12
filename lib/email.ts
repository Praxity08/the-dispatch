// Assembles the newsletter email and sends it through Gmail SMTP.
import nodemailer, { type Transporter } from "nodemailer";
import { query } from "./db";
import { appUrl, requireEnv } from "./env";
import { TOPICS, type Topic } from "./topics";
import { sendTimeFor } from "./week";

export type EmailStory = { position: number; topic: Topic; headline: string; url: string; publisher: string; commentary: string };
export type EmailIssue = { id: number; issue_number: number; week_start: string; subject: string; intro: string; stories: EmailStory[] };

/** The approved lineup, in running order. */
export async function loadEmailIssue(issueId: number): Promise<EmailIssue> {
  const [issue] = await query<Omit<EmailIssue, "stories">>(
    "select id, issue_number, week_start::text, coalesce(subject, '') as subject, coalesce(intro, '') as intro from issues where id = $1",
    [issueId],
  );
  if (!issue) throw new Error(`issue ${issueId} not found`);
  const stories = await query<EmailStory>(
    `select ii.position, ii.topic, s.headline, a.url, a.publisher, coalesce(ii.commentary, '') as commentary
     from issue_items ii join stories s on s.id = ii.story_id join articles a on a.id = ii.article_id
     where ii.issue_id = $1 and ii.role = 'selected' and ii.status in ('approved', 'pending')
     order by ii.position`,
    [issueId],
  );
  return { ...issue, stories };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function issueDate(week: string): string {
  return sendTimeFor(week).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" });
}

type Links = { unsubscribeUrl: string; webUrl?: string };

export function renderHtml(issue: EmailIssue, links: Links): string {
  const serif = "Georgia, 'Times New Roman', serif";
  const sans = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
  const preheader = issue.intro.split(/(?<=[.?])\s/)[0] ?? "";

  const stories = issue.stories
    .map(
      (s, i) => `
      <tr><td style="padding:22px 32px;border-top:1px solid #e7e5e4;">
        <div style="font:bold 11px ${sans};letter-spacing:0.1em;text-transform:uppercase;color:#b45309;">${String(i + 1).padStart(2, "0")} &middot; ${esc(TOPICS[s.topic] ?? s.topic)}</div>
        <a href="${esc(s.url)}" style="display:block;margin:8px 0 4px;font:bold 20px/1.35 ${serif};color:#1c1917;text-decoration:none;">${esc(s.headline)}</a>
        <div style="font:13px ${sans};color:#78716c;">via ${esc(s.publisher)}</div>
        <p style="margin:12px 0 0;font:16px/1.65 ${serif};color:#292524;">${esc(s.commentary)}</p>
      </td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>${esc(issue.subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f4;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:10px;">
    <tr><td style="padding:32px 32px 8px;">
      <div style="font:bold 12px ${sans};letter-spacing:0.12em;text-transform:uppercase;color:#b45309;">Issue #${issue.issue_number} &middot; ${esc(issueDate(issue.week_start))}</div>
      <div style="margin:6px 0 2px;font:bold 34px/1.1 ${serif};color:#1c1917;">The Dispatch</div>
      <div style="font:14px ${sans};color:#78716c;">The Indian startup ecosystem, curated by Shreya</div>
    </td></tr>
    <tr><td style="padding:18px 32px 26px;font:17px/1.65 ${serif};color:#292524;">${esc(issue.intro)}</td></tr>
    ${stories}
    <tr><td style="padding:26px 32px 30px;border-top:1px solid #e7e5e4;font:16px/1.6 ${serif};color:#292524;">
      &mdash; Shreya<br>
      <span style="font:14px ${sans};color:#57534e;">Got a tip, or think I got one wrong? Just hit reply. If this was worth your time, forward it to a friend.</span>
    </td></tr>
  </table>
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
    <tr><td style="padding:18px 32px;font:12px/1.6 ${sans};color:#a8a29e;text-align:center;">
      You're getting The Dispatch because you subscribed at ${esc(appUrl().replace(/^https?:\/\//, ""))}.<br>
      <a href="${esc(links.unsubscribeUrl)}" style="color:#78716c;">Unsubscribe</a>${links.webUrl ? ` &middot; <a href="${esc(links.webUrl)}" style="color:#78716c;">View in browser</a>` : ""}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

export function renderText(issue: EmailIssue, links: Links): string {
  const stories = issue.stories
    .map((s, i) => `${i + 1}. ${s.headline}\n   ${s.url} (via ${s.publisher})\n\n   ${s.commentary}`)
    .join("\n\n");
  return `THE DISPATCH · Issue #${issue.issue_number} · ${issueDate(issue.week_start)}\n\n${issue.intro}\n\n${stories}\n\n— Shreya\nGot a tip? Just hit reply.\n\nUnsubscribe: ${links.unsubscribeUrl}${links.webUrl ? `\nView in browser: ${links.webUrl}` : ""}\n`;
}

// ---------------------------------------------------------------- Gmail SMTP

let transport: Transporter | null = null;

/** EMAIL_DRY_RUN=1 runs the whole send path but hands messages to a no-op transport (used by tests). */
export const dryRun = () => process.env.EMAIL_DRY_RUN === "1";

function mailer(): Transporter {
  if (!transport && dryRun()) transport = nodemailer.createTransport({ jsonTransport: true });
  if (!transport) {
    transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      pool: true,
      maxConnections: 2,
      auth: { user: requireEnv("GMAIL_USER"), pass: requireEnv("GMAIL_APP_PASSWORD").replace(/\s+/g, "") },
    });
  }
  return transport;
}

export function emailConfigured(): boolean {
  return dryRun() || (!!process.env.GMAIL_USER && !!process.env.GMAIL_APP_PASSWORD);
}

export async function sendEmail(msg: { to: string; subject: string; html: string; text: string; oneClickUrl?: string }): Promise<string> {
  const from = requireEnv("GMAIL_USER");
  const info = await mailer().sendMail({
    from: { name: "Shreya at The Dispatch", address: from },
    replyTo: from,
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    headers: msg.oneClickUrl
      ? {
          "List-Unsubscribe": `<${msg.oneClickUrl}>, <mailto:${from}?subject=unsubscribe>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : {},
  });
  return info.messageId;
}
