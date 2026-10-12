// Offline test of bounce / unsubscribe classification:  npx tsx scripts/check-bounces.ts
import { simpleParser } from "mailparser";
import { classifyMessage, replyBody } from "../lib/bounces";

const OWN = "shreyanewsletter104@gmail.com";
const cases: { label: string; expect: string; email?: string; raw: string }[] = [
  {
    label: "Gmail 'Address not found' bounce",
    expect: "hard_bounce",
    email: "ghost.user@gmail.com",
    raw: `From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: ${OWN}
Subject: Delivery Status Notification (Failure)
X-Failed-Recipients: ghost.user@gmail.com
Message-ID: <b1@mx.google.com>
Content-Type: text/plain

Address not found
Your message wasn't delivered to ghost.user@gmail.com because the address couldn't be found, or is unable to receive mail.
The response was: 550 5.1.1 The email account that you tried to reach does not exist.`,
  },
  {
    label: "RFC 3464 delivery-status report",
    expect: "hard_bounce",
    email: "left.the.company@acme.in",
    raw: `From: postmaster@acme.in
To: ${OWN}
Subject: Undeliverable: The Dispatch #105
Message-ID: <b2@acme.in>
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="XX"

--XX
Content-Type: text/plain

Delivery has failed to these recipients.
--XX
Content-Type: message/delivery-status

Reporting-MTA: dns; mx.acme.in
Final-Recipient: rfc822; left.the.company@acme.in
Action: failed
Status: 5.2.1
--XX--`,
  },
  {
    label: "Mailbox full (temporary)",
    expect: "soft_bounce",
    email: "busy.founder@startup.io",
    raw: `From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: ${OWN}
Subject: Delivery Status Notification (Delay)
X-Failed-Recipients: busy.founder@startup.io
Message-ID: <b3@mx.google.com>
Content-Type: text/plain

Message temporarily rejected. The recipient's mailbox is full. 452 4.2.2 Mailbox full. Gmail will keep trying.`,
  },
  {
    label: "List-Unsubscribe mailto email",
    expect: "unsubscribe",
    email: "reader@company.com",
    raw: `From: Reader <reader@company.com>
To: ${OWN}
Subject: unsubscribe
Message-ID: <u1@company.com>
Content-Type: text/plain

`,
  },
  {
    label: "Ordinary reader reply",
    expect: "reply",
    email: "fan@company.com",
    raw: `From: Fan <fan@company.com>
To: ${OWN}
Subject: Re: The Dispatch #105 — Sovereignty debates meet public market realities
Message-ID: <r1@company.com>
Content-Type: text/plain

Loved the semiconductor take. Don't unsubscribe me ever.`,
  },
  {
    label: "Out-of-office auto-reply",
    expect: "ignored",
    raw: `From: Busy Person <busy@company.com>
To: ${OWN}
Subject: Automatic reply: The Dispatch #105
Auto-Submitted: auto-replied
In-Reply-To: <abc@gmail.com>
Message-ID: <a1@company.com>
Content-Type: text/plain

I'm away until Monday.`,
  },
  {
    label: "Google security alert",
    expect: "ignored",
    raw: `From: Google <no-reply@accounts.google.com>
To: ${OWN}
Subject: Security alert
Message-ID: <g1@google.com>
Content-Type: text/plain

A new sign-in on Mac.`,
  },
];

let failures = 0;
for (const c of cases) {
  const mail = await simpleParser(c.raw.replace(/\n/g, "\r\n"));
  const out = classifyMessage(mail, OWN);
  const ok = out.kind === c.expect && (c.email === undefined || out.email === c.email);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.label.padEnd(34)} → ${out.kind}${out.email ? ` ${out.email}` : ""}${out.detail ? ` [${out.detail}]` : ""}`);
}
// Quote stripping: only the reader's own words reach the dashboard.
const quoted = await simpleParser(
  `From: Fan <fan@company.com>\r\nTo: ${OWN}\r\nSubject: Re: The Dispatch #105\r\nContent-Type: text/plain\r\n\r\n` +
    "Tip: Zepto is raising again.\r\nHappy to share the deck.\r\n\r\nOn Thu, 15 Oct 2026 at 08:00, Shreya at The Dispatch <\r\nshreyanewsletter104@gmail.com> wrote:\r\n> THE DISPATCH Issue #105\r\n> stories...",
);
const body = replyBody(quoted);
const stripOk = body === "Tip: Zepto is raising again.\nHappy to share the deck.";
if (!stripOk) failures++;
console.log(`${stripOk ? "PASS" : "FAIL"}  ${"Quoted newsletter stripped".padEnd(34)} → ${JSON.stringify(body)}`);
process.exit(failures ? 1 : 0);
