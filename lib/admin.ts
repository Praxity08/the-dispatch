import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireEnv } from "./env";

const COOKIE = "dispatch_admin";

function sessionValue(): string {
  // Changing ADMIN_PASSWORD invalidates every existing session.
  return createHmac("sha256", requireEnv("ADMIN_PASSWORD")).update("dispatch-admin-session").digest("hex");
}

export function passwordMatches(input: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(requireEnv("ADMIN_PASSWORD"));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startSession() {
  (await cookies()).set(COOKIE, sessionValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 3600,
  });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}

export async function isAdmin(): Promise<boolean> {
  const value = (await cookies()).get(COOKIE)?.value ?? "";
  const expected = sessionValue();
  return value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export async function requireAdmin() {
  if (!(await isAdmin())) redirect("/admin/login");
}

// ---- Scoring-rubric unlock: a second, separate password on top of the editor login ----

const RUBRIC_COOKIE = "dispatch_rubric";
const RUBRIC_UNLOCK_MINUTES = 30;

function rubricSessionValue(): string {
  return createHmac("sha256", requireEnv("RUBRIC_PASSWORD")).update("dispatch-rubric-session").digest("hex");
}

export function rubricPasswordMatches(input: string): boolean {
  const expected = process.env.RUBRIC_PASSWORD;
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function unlockRubricSession() {
  (await cookies()).set(RUBRIC_COOKIE, rubricSessionValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/admin",
    maxAge: RUBRIC_UNLOCK_MINUTES * 60,
  });
}

export async function lockRubricSession() {
  (await cookies()).delete({ name: RUBRIC_COOKIE, path: "/admin" });
}

/** True only with both a valid editor session and a valid rubric unlock. */
export async function isRubricUnlocked(): Promise<boolean> {
  if (!process.env.RUBRIC_PASSWORD || !(await isAdmin())) return false;
  const value = (await cookies()).get(RUBRIC_COOKIE)?.value ?? "";
  const expected = rubricSessionValue();
  return value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export const RUBRIC_UNLOCK_MINUTES_LABEL = `${RUBRIC_UNLOCK_MINUTES} minutes`;
