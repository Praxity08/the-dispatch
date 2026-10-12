// Resend posts delivery events (bounces, spam complaints) to /api/webhooks/resend.
// Requests are signed the Svix way: HMAC-SHA256 of "<id>.<timestamp>.<body>" with the webhook secret.
import { createHmac, timingSafeEqual } from "node:crypto";
import { applyMailOutcome, type Outcome } from "./bounces";
import { logEvent, query } from "./db";
import { normaliseEmail } from "./subscribers";

const TOLERANCE_S = 5 * 60; // reject replays older than five minutes

/** True when the request really came from Resend. Exported for tests. */
export function verifyResendSignature(secret: string, headers: { id: string | null; timestamp: string | null; signature: string | null }, body: string, now = Date.now()): boolean {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  // The header can carry several signatures ("v1,<base64> v1,<base64>") during secret rotation.
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

type ResendEvent = {
  type: string;
  data?: { email_id?: string; to?: string[] | string; bounce?: { type?: string; subType?: string; message?: string } };
};

/** Maps a Resend event to the same outcome the Gmail inbox scan produces. */
export function outcomeFor(event: ResendEvent): Outcome | null {
  const to = Array.isArray(event.data?.to) ? event.data?.to[0] : event.data?.to;
  const email = normaliseEmail(to ?? "");
  if (!email) return null;
  if (event.type === "email.bounced") {
    const b = event.data?.bounce;
    const permanent = !b?.type || /permanent|hard/i.test(b.type);
    return { kind: permanent ? "hard_bounce" : "soft_bounce", email, detail: [b?.type, b?.subType, b?.message].filter(Boolean).join(" · ").slice(0, 200) || "bounced" };
  }
  // A reader marking the newsletter as spam: stop emailing them, like an unsubscribe.
  if (event.type === "email.complained") return { kind: "unsubscribe", email, detail: "spam complaint (Resend)" };
  return null;
}

/** Handles one verified event. Each event id is processed once, however often Resend retries it. */
export async function handleResendEvent(eventId: string, event: ResendEvent) {
  const [seen] = await query("select 1 from processed_mail where message_id = $1", [`resend:${eventId}`]);
  if (seen) return { duplicate: true };
  const outcome = outcomeFor(event);
  const changed = outcome ? await applyMailOutcome(outcome) : false;
  await query("insert into processed_mail (message_id, kind, email, detail) values ($1, $2, $3, $4) on conflict do nothing", [
    `resend:${eventId}`,
    outcome?.kind ?? "ignored",
    outcome?.email ?? null,
    outcome?.detail ?? event.type,
  ]);
  if (outcome) await logEvent("resend_event", { type: event.type, kind: outcome.kind, changed });
  return { handled: !!outcome, changed };
}
