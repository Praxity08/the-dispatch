// Minimal Telegram Bot API client.

export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
export type InlineKeyboard = InlineButton[][];

export type TgUser = { id: number; first_name?: string; username?: string };
export type TgMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  reply_to_message?: TgMessage;
  reply_markup?: { inline_keyboard: InlineKeyboard };
};
export type TgCallbackQuery = { id: string; from: TgUser; message?: TgMessage; data?: string };
export type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function tg<T = unknown>(method: string, params: Record<string, unknown> = {}, retries = 2): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as { ok: boolean; result: T; description?: string; parameters?: { retry_after?: number } };
  if (data.ok) return data.result;
  // Editing a message to identical content isn't an error worth failing on.
  if (data.description?.includes("message is not modified")) return undefined as T;
  if (res.status === 429 && retries > 0) {
    await sleep(((data.parameters?.retry_after ?? 2) + 0.5) * 1000);
    return tg<T>(method, params, retries - 1);
  }
  throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
}

/** Escapes text for Telegram's HTML parse mode. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const button = (text: string, data: string): InlineButton => ({ text, callback_data: data });

export const chatId = () => Number(process.env.TELEGRAM_CHAT_ID);
export const adminId = () => Number(process.env.TELEGRAM_ADMIN_USER_ID);

export async function sendHtml(text: string, keyboard?: InlineKeyboard, extra: Record<string, unknown> = {}) {
  return tg<TgMessage>("sendMessage", {
    chat_id: chatId(),
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    ...extra,
  });
}

export async function editHtml(messageId: number, text: string, keyboard?: InlineKeyboard) {
  return tg("editMessageText", {
    chat_id: chatId(),
    message_id: messageId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard ?? [] },
  });
}
