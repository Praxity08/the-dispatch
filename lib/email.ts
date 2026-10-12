// Assembles the newsletter email and sends it through Gmail SMTP.
import nodemailer, { type Transporter } from "nodemailer";
import { query } from "./db";
import { publicSiteUrl, requireEnv } from "./env";
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

/** "Thursday, 15 October 2026": the send day in IST. */
function issueDate(week: string): string {
  return sendTimeFor(week).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

type Links = { unsubscribeUrl: string; webUrl?: string };

// Design tokens (design_handoff_newsletter_email).
const C = {
  ink: "#1E1E1E",
  body: "#2E2B29",
  secondary: "#4A4643",
  muted: "#6E6A66",
  footer: "#8A857F",
  orange: "#E0663A",
  orangeText: "#C4532B",
  ground: "#F5F3F0",
  card: "#FFFFFF",
  border: "#E8E4DE",
  divider: "#EEEAE4",
};
const SERIF = "'Source Serif 4', Georgia, 'Times New Roman', serif";
const SANS = "Archivo, Helvetica, Arial, sans-serif";
const LOGO = { width: 230, height: 85 }; // public/email/dispatch-logo.png is 1070 × 397 (sharp on retina)
const num = (n: number) => String(n).padStart(2, "0");

/** One white card in the column. Cards stack with 12px between them. */
const card = (inner: string, { padding = "22px 24px", radius = 20, id = "" } = {}) => `
<tr><td style="padding:0 0 12px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
    <tr><td class="card-pad"${id ? ` id="${id}"` : ""} style="background:${C.card};border:1px solid ${C.border};border-radius:${radius}px;padding:${padding};">${inner}</td></tr>
  </table>
</td></tr>`;

/** A bulletproof button: the padded link sits inside a coloured table cell. */
const button = (label: string, href: string, dark: boolean) => `
<td style="border-radius:12px;background:${dark ? C.ink : C.card};${dark ? "" : `border:1px solid ${C.border};`}">
  <a href="${esc(href)}" style="display:inline-block;padding:10px 18px;font:600 14px/1.2 ${SANS};color:${dark ? "#FFFFFF" : C.ink};text-decoration:none;border-radius:12px;">${label}</a>
</td>`;

export function renderHtml(issue: EmailIssue, links: Links, { showContents = true } = {}): string {
  const site = publicSiteUrl();
  const replyTo = process.env.GMAIL_USER ?? "";
  const preheader = issue.intro.split(/(?<=[.?])\s/)[0] ?? "";
  const linkStyle = `color:${C.ink};text-decoration:underline;text-decoration-color:${C.orange};text-underline-offset:3px;`;
  const replyHref = `mailto:${replyTo}?subject=${encodeURIComponent(`Re: The Dispatch #${issue.issue_number}`)}`;
  const forwardHref = `mailto:?subject=${encodeURIComponent(issue.subject || `The Dispatch #${issue.issue_number}`)}&body=${encodeURIComponent(
    `I thought you'd like this week's Dispatch, Shreya's take on the Indian startup ecosystem:\n\n${links.webUrl ?? site}\n\nSubscribe: ${site}/#subscribe`,
  )}`;

  const header = card(
    `
    <img src="${esc(`${site}/email/dispatch-logo.png`)}" width="${LOGO.width}" height="${LOGO.height}" alt="The Dispatch — India's startup brief" class="logo" style="display:block;width:${LOGO.width}px;max-width:70%;height:auto;border:0;outline:none;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border-top:1px solid ${C.divider};">
      <tr>
        <td style="padding-top:14px;font:600 12px/1.4 ${SANS};letter-spacing:0.1em;text-transform:uppercase;color:${C.orangeText};">Issue #${issue.issue_number}</td>
        <td align="right" style="padding-top:14px;font:13px/1.4 ${SANS};color:${C.muted};">${esc(issueDate(issue.week_start))}</td>
      </tr>
    </table>
    <p style="margin:18px 0 0 0;font:18px/1.6 ${SERIF};color:${C.body};">${esc(issue.intro)}</p>`,
    { padding: "26px 26px 22px", radius: 22 },
  );

  const contents = showContents
    ? card(
        `
    <div style="padding-bottom:6px;font:600 11px/1.4 ${SANS};letter-spacing:0.1em;text-transform:uppercase;color:${C.muted};">In this issue</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${issue.stories
        .map(
          (s, i) => `<tr>
        <td width="28" valign="top" style="width:28px;padding:5px 0;font:700 12px/1.6 ${SANS};color:${C.orange};"><a href="#story-${num(i + 1)}" style="color:${C.orange};text-decoration:none;">${num(i + 1)}</a></td>
        <td valign="top" style="padding:5px 0;font:14px/1.4 ${SANS};color:${C.ink};"><a href="#story-${num(i + 1)}" style="color:${C.ink};text-decoration:none;">${esc(s.headline)}</a></td>
      </tr>`,
        )
        .join("")}
    </table>`,
        { padding: "16px 22px" },
      )
    : "";

  const stories = issue.stories
    .map((s, i) =>
      card(
        `
    <a name="story-${num(i + 1)}" id="story-${num(i + 1)}"></a>
    <div style="font:700 12px/1.4 ${SANS};letter-spacing:0.06em;color:${C.orange};">${num(i + 1)}<span style="display:inline-block;width:14px;height:2px;margin:0 10px;background:${C.orange};border-radius:2px;vertical-align:middle;"></span><span style="font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${C.muted};">${esc(TOPICS[s.topic] ?? s.topic)}</span></div>
    <a href="${esc(s.url)}" style="display:block;margin-top:10px;font:700 23px/1.28 ${SERIF};letter-spacing:-0.01em;color:${C.ink};text-decoration:none;">${esc(s.headline)}</a>
    <div style="margin-top:4px;font:13px/1.4 ${SANS};color:${C.muted};">via <a href="${esc(s.url)}" style="color:${C.muted};text-decoration:underline;">${esc(s.publisher)}</a></div>
    <p style="margin:10px 0 0 0;font:17px/1.6 ${SERIF};color:${C.body};">${esc(s.commentary)}</p>`,
        { id: `card-${num(i + 1)}` },
      ),
    )
    .join("");

  const signoff = card(`
    <div style="font:600 20px/1.3 ${SERIF};color:${C.ink};">&mdash; Shreya</div>
    <p style="margin:10px 0 0 0;font:15px/1.55 ${SANS};color:${C.secondary};">Got a tip, or think I got one wrong? Just hit reply. If this was worth your time, forward it to a friend.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">
      <tr>${button("Reply to Shreya", replyHref, true)}<td width="8" style="width:8px;"></td>${button("Forward to a friend", forwardHref, false)}</tr>
    </table>`);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>${esc(issue.subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&display=swap" rel="stylesheet">
<style>
  a { ${linkStyle} }
  @media (max-width: 640px) {
    .card-pad { padding: 18px !important; }
    .logo { width: 70% !important; height: auto !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.ground};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ground};">
  <tr><td align="center" style="padding:28px 14px 36px 14px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;">
      ${header}${contents}${stories}${signoff}
      <tr><td style="padding:10px 18px 0 18px;font:13px/1.5 ${SANS};color:${C.footer};">
        You're getting The Dispatch because you subscribed at ${esc(site.replace(/^https?:\/\//, ""))}.<br>
        <a href="${esc(links.unsubscribeUrl)}" style="color:${C.muted};text-decoration:underline;">Unsubscribe</a>${links.webUrl ? ` &middot; <a href="${esc(links.webUrl)}" style="color:${C.muted};text-decoration:underline;">View in browser</a>` : ""}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

export function renderText(issue: EmailIssue, links: Links): string {
  const contents = issue.stories.map((s, i) => `  ${num(i + 1)}  ${s.headline}`).join("\n");
  const stories = issue.stories
    .map((s, i) => `${num(i + 1)} — ${(TOPICS[s.topic] ?? s.topic).toUpperCase()}\n${s.headline}\nvia ${s.publisher}: ${s.url}\n\n${s.commentary}`)
    .join("\n\n----------------------------------------\n\n");
  return `THE DISPATCH · India's startup brief
Issue #${issue.issue_number} · ${issueDate(issue.week_start)}

${issue.intro}

IN THIS ISSUE
${contents}

----------------------------------------

${stories}

----------------------------------------

— Shreya
Got a tip, or think I got one wrong? Just hit reply. If this was worth your time, forward it to a friend.

You're getting The Dispatch because you subscribed at ${publicSiteUrl().replace(/^https?:\/\//, "")}.
Unsubscribe: ${links.unsubscribeUrl}${links.webUrl ? `\nView in browser: ${links.webUrl}` : ""}
`;
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
