import { after } from "next/server";
import { handleUpdate } from "@/lib/review";
import type { TgUpdate } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Telegram webhook. Verified by the secret token set with setWebhook; work runs after we reply 200. */
export async function POST(req: Request) {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  const update = (await req.json()) as TgUpdate;
  // Reply immediately so Telegram doesn't retry; Gemini rewrites can take a while.
  after(() => handleUpdate(update).catch((err) => console.error("telegram update failed", update.update_id, err)));
  return new Response("ok");
}
