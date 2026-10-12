// Reads the newsletter's Gmail inbox over IMAP for (a) bounce notifications, (b) "unsubscribe" emails
// sent via the List-Unsubscribe mailto link, and (c) replies from readers, which go to the dashboard.
import { ImapFlow } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import { logEvent, query } from "./db";
import { requireEnv } from "./env";
import { normaliseEmail } from "./subscribers";
import { appUrl } from "./env";
import { esc, sendHtml } from "./telegram";
import { stripHtml, truncate } from "./text";

const SOFT_BOUNCE_LIMIT = 3;

type Outcome = { kind: "hard_bounce" | "soft_bounce" | "unsubscribe" | "reply" | "ignored"; email: string | null; detail: string };

function allText(mail: ParsedMail): string {
  // The machine-readable delivery report usually arrives as a message/delivery-status attachment.
  const parts = [mail.text ?? "", ...mail.attachments.filter((a) => /delivery-status|rfc822-headers|text/i.test(a.contentType)).map((a) => a.content.toString("utf8"))];
  return parts.join("\n");
}

/** Classifies one inbound message. Exported for tests. */
export function classifyMessage(mail: ParsedMail, ownAddress: string): Outcome {
  const from = mail.from?.value[0]?.address?.toLowerCase() ?? "";
  const subject = mail.subject ?? "";
  const text = allText(mail);

  if (/mailer-daemon|postmaster/.test(from) || /delivery status notification|undeliverable|returned mail|delivery failure/i.test(subject)) {
    const header = mail.headers.get("x-failed-recipients");
    const candidates = [
      typeof header === "string" ? header : "",
      /Final-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)/i.exec(text)?.[1] ?? "",
      /Original-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)/i.exec(text)?.[1] ?? "",
      /(?:wasn't|was not|couldn't be|could not be) delivered to\s+<?([^\s>]+@[^\s>]+?)>?(?:\s|$|\.)/i.exec(text)?.[1] ?? "",
    ];
    const email = candidates.map((c) => normaliseEmail(c.split(",")[0] ?? "")).find((e) => e && e !== ownAddress) ?? null;
    const code = /Status:\s*([245]\.\d{1,3}\.\d{1,3})/i.exec(text)?.[1] ?? /\b([45]\.\d\.\d{1,3})\b/.exec(text)?.[1] ?? "";
    const permanent =
      code.startsWith("5") || /address not found|does not exist|no such user|user unknown|mailbox unavailable|account (?:is )?disabled/i.test(text);
    return { kind: email ? (permanent ? "hard_bounce" : "soft_bounce") : "ignored", email, detail: code || subject.slice(0, 120) };
  }

  if (/^\s*(re:\s*)?unsubscribe\b/i.test(subject) || /^\s*unsubscribe\s*$/im.test((mail.text ?? "").split("\n").slice(0, 3).join("\n"))) {
    return { kind: "unsubscribe", email: normaliseEmail(from), detail: "unsubscribe email" };
  }
  // A person answering the newsletter (it says "just hit reply"). Fresh emails from subscribers are
  // picked up in processInbox, which can check the subscriber list.
  if (isFromPerson(mail, ownAddress) && (mail.inReplyTo || /\bdispatch\b/i.test(subject))) {
    return { kind: "reply", email: normaliseEmail(from), detail: subject.slice(0, 120) };
  }
  return { kind: "ignored", email: null, detail: subject.slice(0, 120) };
}

/** Not us, not a robot, not an out-of-office. */
export function isFromPerson(mail: ParsedMail, ownAddress: string): boolean {
  const from = mail.from?.value[0]?.address?.toLowerCase() ?? "";
  if (!from || from === ownAddress) return false;
  if (/no-?reply|do-?not-?reply|notifications?@|mailer-daemon|postmaster|bounce/.test(from)) return false;
  const auto = String(mail.headers.get("auto-submitted") ?? "no").toLowerCase();
  const precedence = String(mail.headers.get("precedence") ?? "").toLowerCase();
  if (auto !== "no" || /bulk|list|junk|auto_reply/.test(precedence) || mail.headers.has("list-id")) return false;
  return !/out of (the )?office|automatic reply|auto-?reply|away from|on leave/i.test(mail.subject ?? "");
}

/** The reader's own words: everything above the quoted newsletter ("On … wrote:", "> …", "From: …"). */
export function replyBody(mail: ParsedMail): string {
  const text = mail.text?.trim() ? mail.text : stripHtml(typeof mail.html === "string" ? mail.html.replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n") : "");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^>/.test(t)) break;
    // Gmail wraps "On Mon, 12 Oct 2026 at 08:00, Shreya <…> wrote:" across two lines.
    if (/^On\s/.test(t) && /wrote:\s*$/.test(`${t} ${lines[i + 1]?.trim() ?? ""}`)) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)/i.test(t) || /^_{10,}$/.test(t)) break;
    if (/^From:\s.+/i.test(t) && out.some((l) => l.trim())) break;
    if (/^Sent from my \w+/i.test(t)) break;
    out.push(line);
  }
  const body = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return truncate(body || text.trim(), 5000);
}

const stripBrackets = (id: string) => id.trim().replace(/^<|>$/g, "");

async function saveReply(mail: ParsedMail, messageId: string): Promise<boolean> {
  const email = normaliseEmail(mail.from?.value[0]?.address ?? "");
  const body = replyBody(mail);
  if (!email || !body) return false;
  const refs = [mail.inReplyTo ?? "", ...(Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [])]
    .flatMap((r) => r.split(/\s+/))
    .filter(Boolean)
    .map(stripBrackets);
  // Which issue they're answering: the email they replied to, else "#105" in the subject.
  const [byRef] = refs.length
    ? await query<{ issue_id: number }>("select issue_id from deliveries where trim(both '<>' from message_id) = any($1::text[]) limit 1", [refs])
    : [];
  const number = /#\s?(\d{2,4})\b/.exec(mail.subject ?? "")?.[1];
  const [byNumber] = !byRef && number ? await query<{ id: number }>("select id from issues where issue_number = $1", [Number(number)]) : [];
  const [subscriber] = await query<{ id: number }>("select id from subscribers where email = $1", [email]);
  const rows = await query(
    `insert into reader_replies (message_id, from_email, from_name, subscriber_id, issue_id, subject, body, received_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (message_id) do nothing returning id`,
    [messageId, email, mail.from?.value[0]?.name || null, subscriber?.id ?? null, byRef?.issue_id ?? byNumber?.id ?? null, mail.subject ?? null, body, mail.date ?? new Date()],
  );
  return rows.length > 0;
}

async function apply(outcome: Outcome) {
  if (!outcome.email) return false;
  if (outcome.kind === "unsubscribe") {
    const rows = await query("update subscribers set status = 'unsubscribed', unsubscribed_at = now() where email = $1 and status = 'active' returning id", [outcome.email]);
    return rows.length > 0;
  }
  if (outcome.kind === "hard_bounce" || outcome.kind === "soft_bounce") {
    const hard = outcome.kind === "hard_bounce";
    const rows = await query<{ id: number }>(
      `update subscribers set bounce_count = bounce_count + 1, last_bounce_at = now(), last_bounce_reason = $2,
              status = case when $3::boolean or bounce_count + 1 >= $4::int then 'bounced' else status end
       where email = $1 and status <> 'unsubscribed' returning id`,
      [outcome.email, outcome.detail, hard, SOFT_BOUNCE_LIMIT],
    );
    if (rows[0]) {
      await query(
        `update deliveries set status = 'bounced', error = $2
         where id = (select id from deliveries where subscriber_id = $1 and status = 'sent' order by sent_at desc nulls last limit 1)`,
        [rows[0].id, outcome.detail],
      );
    }
    return rows.length > 0;
  }
  return false;
}

/** Scans the last `days` days of the inbox. Safe to run repeatedly: each message is processed once. */
export async function processInbox({ days = 7 } = {}) {
  const user = requireEnv("GMAIL_USER");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass: requireEnv("GMAIL_APP_PASSWORD").replace(/\s+/g, "") },
    logger: false,
  });
  const summary = { scanned: 0, hard_bounce: 0, soft_bounce: 0, unsubscribe: 0, reply: 0, ignored: 0, changed: 0 };
  const replies: { name: string; body: string }[] = [];

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    // Everything recent that we didn't send ourselves: bounces, unsubscribes and reader replies.
    const uids = await client.search({ gmraw: `newer_than:${days}d -from:me` }, { uid: true });
    if (uids && uids.length) {
      for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
        if (!msg.source) continue;
        const mail = await simpleParser(msg.source);
        const messageId = mail.messageId ?? `uid:${msg.uid}`;
        const [seen] = await query("select 1 from processed_mail where message_id = $1", [messageId]);
        if (seen) continue;

        summary.scanned++;
        const own = user.toLowerCase();
        const outcome = classifyMessage(mail, own);
        // A new email (not a reply) from a subscriber, e.g. a tip, also belongs in the Replies tab.
        if (outcome.kind === "ignored" && isFromPerson(mail, own)) {
          const sender = normaliseEmail(mail.from?.value[0]?.address ?? "");
          const [known] = sender ? await query("select 1 from subscribers where email = $1", [sender]) : [];
          if (known) Object.assign(outcome, { kind: "reply", email: sender });
        }
        summary[outcome.kind]++;
        if (outcome.kind === "reply") {
          if (await saveReply(mail, messageId)) replies.push({ name: mail.from?.value[0]?.name || outcome.email || "A reader", body: replyBody(mail) });
        } else if (await apply(outcome)) summary.changed++;
        await query("insert into processed_mail (message_id, kind, email, detail) values ($1, $2, $3, $4) on conflict do nothing", [
          messageId,
          outcome.kind,
          outcome.email,
          outcome.detail,
        ]);
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  await logEvent("inbox_processed", summary);
  if (summary.changed) {
    await sendHtml(
      `📭 List hygiene: ${summary.hard_bounce} hard bounces, ${summary.soft_bounce} soft bounces, ${summary.unsubscribe} unsubscribe emails processed. ${summary.changed} subscribers updated.`,
    ).catch(() => {});
  }
  if (replies.length) {
    const preview = replies.slice(0, 3).map((r) => `<b>${esc(r.name)}</b>: “${esc(truncate(r.body.replace(/\s+/g, " "), 140))}”`).join("\n");
    const more = replies.length > 3 ? `\n…and ${replies.length - 3} more.` : "";
    const link = process.env.APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL ? [[{ text: "Read them on the dashboard", url: `${appUrl()}/admin?tab=replies` }]] : undefined;
    await sendHtml(`💬 ${replies.length} new reader ${replies.length === 1 ? "reply" : "replies"}\n\n${preview}${more}`, link).catch(() => {});
  }
  return summary;
}
