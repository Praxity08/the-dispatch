// Local stand-in for the webhook: long-polls Telegram and feeds updates to the same handler.
//   npm run telegram:poll        (stop with Ctrl+C; only works while no webhook is set)
import { handleUpdate } from "../lib/review";
import { tg, type TgUpdate } from "../lib/telegram";

async function main() {
  await tg("deleteWebhook", {});
  console.log("Polling Telegram for updates…");
  let offset = 0;
  for (;;) {
    const updates = await tg<TgUpdate[]>("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
    for (const update of updates) {
      offset = update.update_id + 1;
      const what = update.callback_query?.data ?? update.message?.text?.slice(0, 40) ?? "update";
      console.log(new Date().toISOString(), what);
      await handleUpdate(update).catch((err) => console.error("handler error:", err));
    }
  }
}
main();
