import { createHmac, timingSafeEqual } from "node:crypto";
import { logEvent, query } from "./db";
import { appUrl, requireEnv } from "./env";

export type Subscriber = { id: number; email: string; name: string | null; status: "active" | "unsubscribed" | "bounced" };

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

export function normaliseEmail(email: string): string | null {
  const e = email.trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}

export function unsubscribeToken(subscriberId: number): string {
  return createHmac("sha256", requireEnv("UNSUBSCRIBE_SECRET")).update(`unsubscribe:${subscriberId}`).digest("hex").slice(0, 32);
}

export function verifyUnsubscribeToken(subscriberId: number, token: string): boolean {
  const expected = Buffer.from(unsubscribeToken(subscriberId));
  const given = Buffer.from(token ?? "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Link shown in the email footer (opens a confirmation page). */
export function unsubscribePageUrl(subscriberId: number): string {
  return `${appUrl()}/unsubscribe?s=${subscriberId}&t=${unsubscribeToken(subscriberId)}`;
}

/** RFC 8058 one-click endpoint used in the List-Unsubscribe header (mail clients POST to it). */
export function oneClickUnsubscribeUrl(subscriberId: number): string {
  return `${appUrl()}/api/unsubscribe?s=${subscriberId}&t=${unsubscribeToken(subscriberId)}`;
}

export async function addSubscriber(rawEmail: string, name?: string): Promise<{ ok: boolean; message: string }> {
  const email = normaliseEmail(rawEmail);
  if (!email) return { ok: false, message: "That doesn't look like a valid email address." };
  // Subscribing again is an explicit opt-in, so it reactivates an unsubscribed or bounced address.
  const [row] = await query<{ id: number; was: string | null }>(
    `insert into subscribers (email, name) values ($1, nullif($2, ''))
     on conflict (email) do update set status = 'active', bounce_count = 0, unsubscribed_at = null,
       name = coalesce(nullif(excluded.name, ''), subscribers.name)
     returning id, (select status from subscribers where email = $1) as was`,
    [email, (name ?? "").trim().slice(0, 100)],
  );
  await logEvent("subscribed", { subscriber: row.id, previously: row.was });
  return { ok: true, message: row.was === "active" ? "You're already subscribed." : "You're in. The Dispatch arrives every Thursday morning." };
}

export async function unsubscribe(subscriberId: number, via: string): Promise<Subscriber | undefined> {
  const [row] = await query<Subscriber>(
    `update subscribers set status = 'unsubscribed', unsubscribed_at = now()
     where id = $1 and status <> 'unsubscribed' returning id, email, name, status`,
    [subscriberId],
  );
  if (row) await logEvent("unsubscribed", { subscriber: subscriberId, via });
  return row;
}

export async function getSubscriber(id: number): Promise<Subscriber | undefined> {
  const [row] = await query<Subscriber>("select id, email, name, status from subscribers where id = $1", [id]);
  return row;
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
}
