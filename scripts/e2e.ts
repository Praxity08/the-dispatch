// End-to-end check of the review → confirm → send gate, driving the real Telegram handler with
// simulated taps from Shreya (and from a stranger). Posts/edits real messages in the review group,
// and changes the live draft (approvals, one swap); edits it makes are reverted.
//   npm run e2e
import { query } from "../lib/db";
import { handleUpdate } from "../lib/review";
import { sendIssue } from "../lib/send";
import { adminId, chatId, type TgUpdate } from "../lib/telegram";
import { sendTimeFor, weekStart } from "../lib/week";

let updateId = 9_000_000;
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function tap(data: string, messageId: number, from = adminId()) {
  const update: TgUpdate = {
    update_id: ++updateId,
    callback_query: { id: `e2e-${updateId}`, from: { id: from }, data, message: { message_id: messageId, chat: { id: chatId(), type: "group" } } },
  };
  await handleUpdate(update);
}

async function reply(text: string, toText: string) {
  await handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: 1,
      chat: { id: chatId(), type: "group" },
      from: { id: adminId() },
      text,
      reply_to_message: { message_id: 2, chat: { id: chatId(), type: "group" }, text: toText },
    },
  });
}

const issueStatus = async (id: number) => (await query<{ status: string }>("select status from issues where id = $1", [id]))[0].status;
const items = (id: number) =>
  query<{ id: number; role: string; status: string; position: number; commentary: string; telegram_message_id: number; edited_by_shreya: boolean }>(
    "select id, role, status, position, commentary, telegram_message_id, edited_by_shreya from issue_items where issue_id = $1 order by role desc, position, id",
    [id],
  );

async function main() {
  const week = weekStart();
  const [issue] = await query<{ id: number; status: string; telegram_control_message_id: number }>(
    "select id, status, telegram_control_message_id from issues where week_start = $1",
    [week],
  );
  if (!issue || issue.status !== "in_review") throw new Error(`need an issue in review (got ${issue?.status})`);
  const id = Number(issue.id);
  const control = Number(issue.telegram_control_message_id);
  // Start from a lineup that still needs review.
  await query("update issue_items set status = 'pending' where issue_id = $1 and role = 'selected' and status = 'approved'", [id]);

  // 1. Hard gate: nothing sends before confirmation, even after the scheduled time.
  const early = await sendIssue({ now: new Date(sendTimeFor(week).getTime() + 3600_000) });
  check("send refused while in review", !early.sent && /not confirmed/.test(String(early.reason)), String(early.reason));

  // 2. A stranger's tap changes nothing.
  let list = await items(id);
  const first = list.find((i) => i.role === "selected" && i.status === "pending")!;
  await tap(`ap:${first.id}`, first.telegram_message_id, 12345);
  check("stranger can't approve", (await items(id)).find((i) => i.id === first.id)!.status === "pending");

  // 3. Approve, drop, restore.
  await tap(`ap:${first.id}`, first.telegram_message_id);
  check("approve", (await items(id)).find((i) => i.id === first.id)!.status === "approved");
  const live = () => list.filter((i) => i.role === "selected" && (i.status === "pending" || i.status === "approved"));
  const second = live()[1];
  await tap(`dr:${second.id}`, second.telegram_message_id);
  check("drop", (await items(id)).find((i) => i.id === second.id)!.status === "dropped");
  await tap(`rs:${second.id}`, second.telegram_message_id);
  check("restore", (await items(id)).find((i) => i.id === second.id)!.status === "pending");

  // 4. Swap the third story for a bench story.
  list = await items(id);
  const third = live()[2];
  const benchPick = list.find((i) => i.role === "bench" && i.status === "pending")!;
  // In real use this tap comes from the swap-picker message, which the bot deletes afterwards.
  await tap(`sp:${third.id}:${benchPick.id}`, 999_999_999);
  list = await items(id);
  const swappedOut = list.find((i) => i.id === third.id)!;
  const swappedIn = list.find((i) => i.id === benchPick.id)!;
  check(
    "swap (or blocked by lineup rules)",
    (swappedOut.status === "swapped_out" && swappedIn.role === "selected" && swappedIn.position === third.position) ||
      (swappedOut.status === "pending" && swappedIn.role === "bench"),
    `out=${swappedOut.status} in=${swappedIn.role}#${swappedIn.position}`,
  );

  // 5. Edit by replying to the edit prompt.
  const fourth = list.filter((i) => i.role === "selected" && i.status === "pending")[1];
  const edited = "Test edit from the end-to-end check. Shreya's own words always win over the draft, even when they break the length rule.";
  await reply(edited, `✏️ Editing #${fourth.position} (ref ${fourth.id}): headline`);
  const afterEdit = (await items(id)).find((i) => i.id === fourth.id)!;
  check("edit by reply saves + approves", afterEdit.commentary === edited && afterEdit.status === "approved" && afterEdit.edited_by_shreya);
  // Put the real commentary back so the test doesn't leave placeholder text in the draft.
  await query("update issue_items set commentary = $2, edited_by_shreya = false where id = $1", [fourth.id, fourth.commentary]);

  // 6. Confirm is refused while stories are pending.
  await tap(`cy:${id}`, control);
  check("confirm refused with pending stories", (await issueStatus(id)) === "in_review");

  // 7. Approve all → confirm.
  await tap(`aa:${id}`, control);
  const pendingLeft = (await items(id)).filter((i) => i.role === "selected" && i.status === "pending").length;
  check("approve all", pendingLeft === 0, `${pendingLeft} pending`);
  await tap(`cf:${id}`, control);
  await tap(`cy:${id}`, control);
  check("confirm", (await issueStatus(id)) === "confirmed");

  // 8. Confirmed but before Thursday 8 AM: still not sent.
  const notYet = await sendIssue({ now: new Date(sendTimeFor(week).getTime() - 60_000) });
  check("send waits for the scheduled time", !notYet.sent && /scheduled/.test(String(notYet.reason)), String(notYet.reason));

  // 9. Locked while confirmed; reopen unlocks.
  const anyItem = (await items(id)).find((i) => i.role === "selected" && i.status === "approved")!;
  await tap(`un:${anyItem.id}`, anyItem.telegram_message_id);
  check("edits locked after confirm", (await items(id)).find((i) => i.id === anyItem.id)!.status === "approved");
  await tap(`ro:${id}`, control);
  check("reopen", (await issueStatus(id)) === "in_review");

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
