// Offline test of the Resend provider and webhook (fetch is mocked; nothing is sent):  npx tsx scripts/check-resend.mts
import { createHmac, randomBytes } from "node:crypto";

process.env.EMAIL_PROVIDER = "resend";
process.env.RESEND_API_KEY = "re_test";
process.env.RESEND_FROM = "Shreya at The Dispatch <shreya@thedispatch.example>";
process.env.GMAIL_USER = "inbox@example.com";
delete process.env.EMAIL_DRY_RUN;

const { emailConfigured, sendBatchSize, sendEmails } = await import("../lib/email");
const { outcomeFor, verifyResendSignature } = await import("../lib/resend-webhook");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` → ${detail}` : ""}`);
};

// A fake Resend batch endpoint that records every call.
type Call = { url: string; headers: Record<string, string>; body: any[] };
let calls: Call[] = [];
let reply: (call: Call, n: number) => { status: number; json: unknown; headers?: Record<string, string> } = (c) => ({ status: 200, json: { data: c.body.map((_, i) => ({ id: `id-${calls.length}-${i}` })) } });
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
  calls.push(call);
  const r = reply(call, calls.length);
  return new Response(JSON.stringify(r.json), { status: r.status, headers: r.headers });
}) as typeof fetch;

const msg = (i: number) => ({ to: `reader${i}@example.com`, subject: "The Dispatch #105", html: "<p>hi</p>", text: "hi", oneClickUrl: `https://x/u/${i}` });

check("configured with key + from address", emailConfigured());
check("send loop hands over 100 at a time", sendBatchSize() === 100);

const out = await sendEmails(Array.from({ length: 250 }, (_, i) => msg(i)), { idempotencyKey: "dispatch-1-7" });
check("250 emails → 3 batch calls (100, 100, 50)", calls.length === 3 && calls.map((c) => c.body.length).join() === "100,100,50", calls.map((c) => c.body.length).join());
check("every email reported sent", out.length === 250 && out.every((o) => o.ok));
const first = calls[0].body[0];
check("replies go to the Gmail inbox", first.reply_to === "inbox@example.com");
check("one-click unsubscribe headers kept", first.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click" && first.headers["List-Unsubscribe"].includes("https://x/u/0"));
check("each batch carries its own idempotency key", calls.map((c) => c.headers["idempotency-key"]).join() === "dispatch-1-7-0,dispatch-1-7-1,dispatch-1-7-2");

// Daily quota on the second batch: first 100 sent, the rest left queued.
calls = [];
reply = (c, n) => (n === 2 ? { status: 429, json: { name: "daily_quota_exceeded", message: "You have reached your daily email sending quota." } } : { status: 200, json: { data: c.body.map((_, i) => ({ id: `q-${i}` })) } });
const q = await sendEmails(Array.from({ length: 250 }, (_, i) => msg(i)));
check("quota hit: stops after the failing batch", calls.length === 2);
check("quota hit: 100 sent, 150 left for the next run", q.filter((o) => o.ok).length === 100 && q.filter((o) => !o.ok && o.quota).length === 150);

// Rate limited once, then fine: retried, not failed.
calls = [];
reply = (c, n) => (n === 1 ? { status: 429, json: { name: "rate_limit_exceeded" }, headers: { "retry-after": "0" } } : { status: 200, json: { data: c.body.map((_, i) => ({ id: `r-${i}` })) } });
const r = await sendEmails([msg(1), msg(2)]);
check("rate limit is retried, not failed", calls.length === 2 && r.every((o) => o.ok));

// One bad address in permissive mode: only that email fails.
calls = [];
reply = (c) => ({ status: 200, json: { data: [{ id: "a" }, { id: "c" }], errors: [{ index: 1, message: "Invalid `to` field" }] } });
const p = await sendEmails([msg(1), msg(2), msg(3)]);
check("a bad address fails alone", p[0].ok && !p[1].ok && p[2].ok && (p[2] as any).id === "c");

// Webhook signatures (Svix format).
const secret = `whsec_${randomBytes(24).toString("base64")}`;
const body = JSON.stringify({ type: "email.bounced", data: { to: ["Ghost@Example.com"], bounce: { type: "Permanent", subType: "General" } } });
const ts = String(Math.floor(Date.now() / 1000));
const sig = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`msg_1.${ts}.${body}`).digest("base64");
check("genuine webhook accepted", verifyResendSignature(secret, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, body));
check("tampered body rejected", !verifyResendSignature(secret, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, body.replace("Permanent", "Transient")));
check("old (replayed) webhook rejected", !verifyResendSignature(secret, { id: "msg_1", timestamp: String(Number(ts) - 3600), signature: `v1,${sig}` }, body));
const bounce = outcomeFor(JSON.parse(body));
check("permanent bounce → hard bounce", bounce?.kind === "hard_bounce" && bounce.email === "ghost@example.com");
check("spam complaint → unsubscribe", outcomeFor({ type: "email.complained", data: { to: ["a@b.co"] } })?.kind === "unsubscribe");
check("other events ignored", outcomeFor({ type: "email.delivered", data: { to: ["a@b.co"] } }) === null);

process.exit(failures ? 1 : 0);
