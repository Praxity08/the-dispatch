"use server";

import { addSubscriber } from "@/lib/subscribers";

export async function subscribe(_: unknown, formData: FormData): Promise<{ ok: boolean; message: string }> {
  // Bots fill every field; quietly pretend success.
  if (String(formData.get("company_website") ?? "")) return { ok: true, message: "You're in." };
  return addSubscriber(String(formData.get("email") ?? ""));
}
