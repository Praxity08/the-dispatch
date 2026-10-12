// Telegram review loop: deliver the draft, let Shreya approve / edit / rewrite / swap / drop each story,
// and record her explicit confirmation. Nothing here sends the newsletter: confirming only unlocks the
// Thursday send job, which refuses to run for any issue that isn't 'confirmed'.
import { logEvent, query } from "./db";
import { rewriteCommentary } from "./draft";
import { handleEarlyLookTap } from "./early-look";
import { emailConfigured } from "./email";
import { addStoryFromLink } from "./manual";
import { sendTestEmail } from "./send";
import { triggerJob } from "./trigger";
import { approveAll, confirmIssue, getIssue as getEditorIssue, lineupProblems, loadEditorItems, readiness, reopenIssue, saveCommentary, setItemStatus, swapIn } from "./editor";
import { adminId, button, chatId, editHtml, esc, type InlineKeyboard, sendHtml, tg, type TgCallbackQuery, type TgMessage, type TgUpdate } from "./telegram";
import { loadRubric } from "./rubric-store";
import { truncate } from "./text";
import { TOPICS, type Topic } from "./topics";
import { formatIst, sendTimeFor, weekStart } from "./week";

type Issue = {
  id: number;
  week_start: string;
  issue_number: number;
  status: string;
  subject: string | null;
  intro: string | null;
  confirmed_at: string | null;
  reminder_sent_at: string | null;
  telegram_control_message_id: number | null;
};

type Item = {
  id: number;
  issue_id: number;
  role: "selected" | "bench";
  status: "pending" | "approved" | "dropped" | "swapped_out";
  position: number;
  topic: Topic;
  reason: string | null;
  score: number | null;
  commentary: string;
  flagged: boolean;
  edited_by_shreya: boolean;
  checks: { problems?: string[] } | null;
  telegram_message_id: number | null;
  swapped_for: number | null;
  headline: string;
  company: string | null;
  url: string;
  publisher: string;
};

const ISSUE_COLUMNS = `id, week_start::text, issue_number, status, subject, intro, confirmed_at, reminder_sent_at, telegram_control_message_id`;

async function getIssue(id: number): Promise<Issue | undefined> {
  const [issue] = await query<Issue>(`select ${ISSUE_COLUMNS} from issues where id = $1`, [id]);
  return issue;
}

async function currentIssue(): Promise<Issue | undefined> {
  const [issue] = await query<Issue>(`select ${ISSUE_COLUMNS} from issues order by week_start desc limit 1`);
  return issue;
}

async function loadItems(issueId: number): Promise<Item[]> {
  const rows = await query<Item>(
    `select ii.id, ii.issue_id, ii.role, ii.status, ii.position, ii.topic, ii.reason, ii.score, coalesce(ii.commentary, '') as commentary,
            ii.flagged, ii.edited_by_shreya, ii.checks, ii.telegram_message_id, ii.swapped_for,
            s.headline, s.company, a.url, a.publisher
     from issue_items ii join stories s on s.id = ii.story_id join articles a on a.id = ii.article_id
     where ii.issue_id = $1 order by ii.role desc, ii.position, ii.id`,
    [issueId],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), issue_id: Number(r.issue_id), telegram_message_id: r.telegram_message_id && Number(r.telegram_message_id) }));
}

async function getItem(id: number): Promise<Item | undefined> {
  const [row] = await query<{ issue_id: number }>("select issue_id from issue_items where id = $1", [id]);
  if (!row) return undefined;
  return (await loadItems(Number(row.issue_id))).find((i) => i.id === id);
}

const active = (items: Item[]) => items.filter((i) => i.role === "selected" && (i.status === "pending" || i.status === "approved"));

// ---------------------------------------------------------------- rendering

const STATUS_LABEL: Record<Item["status"], string> = {
  pending: "⏳ Pending",
  approved: "✅ Approved",
  dropped: "❌ Dropped",
  swapped_out: "🔁 Swapped out",
};

function renderStory(item: Item, total: number, locked: boolean): { text: string; keyboard: InlineKeyboard } {
  const words = item.commentary.split(/\s+/).filter(Boolean).length;
  const lines = [
    `<b>#${item.position}/${total} · ${esc(TOPICS[item.topic] ?? item.topic)}</b> · score ${Math.round(Number(item.score ?? 0))}`,
    `<a href="${esc(item.url)}">${esc(item.headline)}</a> <i>(${esc(item.publisher)})</i>`,
    "",
    item.commentary ? esc(item.commentary) : "<i>(no commentary yet)</i>",
    "",
    `<i>Why it was picked: ${esc(item.reason ?? "—")}</i>`,
  ];
  if (item.flagged && !item.edited_by_shreya && item.checks?.problems?.length) {
    lines.push(`⚠️ <b>Needs a look:</b> ${esc(item.checks.problems.join("; "))}`);
  }
  lines.push(`${STATUS_LABEL[item.status]}${item.edited_by_shreya ? " · ✏️ edited by you" : ""} · ${words} words`);

  let keyboard: InlineKeyboard = [];
  if (!locked) {
    if (item.status === "pending" || item.status === "approved") {
      keyboard = [
        [item.status === "approved" ? button("↩️ Unapprove", `un:${item.id}`) : button("✅ Approve", `ap:${item.id}`), button("❌ Drop", `dr:${item.id}`)],
        [button("✏️ Edit", `ed:${item.id}`), button("♻️ Rewrite", `rw:${item.id}`), button("🔁 Swap", `sw:${item.id}`)],
      ];
    } else if (item.status === "dropped") {
      keyboard = [[button("↩️ Restore", `rs:${item.id}`)]];
    }
  }
  return { text: lines.join("\n"), keyboard };
}

function renderControl(issue: Issue, items: Item[]): { text: string; keyboard: InlineKeyboard } {
  const live = active(items);
  const approved = live.filter((i) => i.status === "approved").length;
  const pending = live.length - approved;
  const dropped = items.filter((i) => i.role === "selected" && i.status === "dropped").length;
  const topics = new Set(live.map((i) => i.topic)).size;
  const problems = lineupProblems(items);
  const sendAt = formatIst(sendTimeFor(issue.week_start));

  const lines = [
    `📋 <b>Review — The Dispatch #${issue.issue_number}</b>`,
    `✅ ${approved} approved · ⏳ ${pending} pending · ❌ ${dropped} dropped · ${topics} topics`,
  ];
  if (problems.length) lines.push(`⚠️ Lineup rules: ${esc(problems.join("; "))}`);

  let keyboard: InlineKeyboard;
  if (issue.status === "in_review") {
    lines.push("", `Nothing is sent until you confirm. Scheduled send: <b>${sendAt}</b>.`);
    keyboard = [
      [button("✅ Approve all pending", `aa:${issue.id}`), button("📧 Test email to me", `te:${issue.id}`)],
      [button("📬 Confirm final draft", `cf:${issue.id}`)],
    ];
  } else if (issue.status === "confirmed") {
    const late = Date.now() >= sendTimeFor(issue.week_start).getTime();
    lines.push(
      "",
      `✅ <b>Confirmed</b>${issue.confirmed_at ? ` at ${esc(formatIst(new Date(issue.confirmed_at)))}` : ""}. ` +
        (late ? `The scheduled time (${sendAt}) has passed: tap <b>Send now</b> when you're ready.` : `Goes out <b>${sendAt}</b>.`),
    );
    keyboard = late
      ? [[button("🚀 Send now", `sn:${issue.id}`)], [button("⏪ Reopen for edits", `ro:${issue.id}`)]]
      : [[button("⏪ Reopen for edits", `ro:${issue.id}`)]];
  } else {
    lines.push("", `Status: <b>${esc(issue.status)}</b>`);
    keyboard = [];
  }
  return { text: lines.join("\n"), keyboard };
}

const isGone = (err: unknown) => /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(String(err));

/** Edits a message in place; if it was deleted from the group, posts it again and returns the new id. */
async function upsertMessage(messageId: number | null, text: string, keyboard: InlineKeyboard): Promise<number | null> {
  if (messageId) {
    try {
      await editHtml(messageId, text, keyboard);
      return null;
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  }
  return (await sendHtml(text, keyboard)).message_id;
}

async function refreshStory(item: Item, issue: Issue, items: Item[]) {
  if (!item.telegram_message_id && item.status === "swapped_out") return;
  const { text, keyboard } = renderStory(item, active(items).length, issue.status !== "in_review");
  const reposted = await upsertMessage(item.telegram_message_id, text, keyboard);
  if (reposted) await query("update issue_items set telegram_message_id = $2 where id = $1", [item.id, reposted]);
}

async function refreshControl(issue: Issue) {
  const { text, keyboard } = renderControl(issue, await loadItems(issue.id));
  const id = issue.telegram_control_message_id ? Number(issue.telegram_control_message_id) : null;
  const reposted = await upsertMessage(id, text, keyboard);
  if (reposted) await query("update issues set telegram_control_message_id = $2 where id = $1", [issue.id, reposted]);
}

/** Keeps Telegram in step after a change made elsewhere (e.g. the dashboard). No-op before delivery. */
export async function syncTelegram(issueId: number) {
  const issue = await getIssue(issueId);
  if (issue?.telegram_control_message_id) await refreshAll(issueId);
}

/** Re-renders every review message for the issue (also re-posts any that were deleted). */
export async function refreshAll(issueId: number) {
  await loadRubric();
  const issue = (await getIssue(issueId))!;
  const items = await loadItems(issueId);
  for (const item of items.filter((i) => i.role === "selected")) await refreshStory(item, issue, items);
  await refreshControl(issue);
}

// ---------------------------------------------------------------- delivery & reminder

/** Wednesday evening: posts the draft to the Telegram group (once). */
export async function deliverDraft(week = weekStart()) {
  await loadRubric();
  // Claim the issue atomically so overlapping cron runs can't post it twice.
  const [issue] = await query<Issue>(
    `update issues set status = 'in_review', delivered_at = now() where week_start = $1 and status = 'drafted' returning ${ISSUE_COLUMNS}`,
    [week],
  );
  if (!issue) {
    const [existing] = await query<{ status: string }>("select status from issues where week_start = $1", [week]);
    return { delivered: false, reason: existing ? `issue is ${existing.status}` : "no issue this week" };
  }

  const items = await loadItems(issue.id);
  const live = active(items);
  const flagged = live.filter((i) => i.flagged).length;
  const topics = new Set(live.map((i) => i.topic)).size;

  await sendHtml(
    [
      `📰 <b>Draft ready: The Dispatch #${issue.issue_number}</b>`,
      "",
      `<b>Subject:</b> ${esc(issue.subject ?? "")}`,
      "",
      `<b>Opening:</b> ${esc(issue.intro ?? "")}`,
      "",
      `${live.length} stories · ${topics} topics${flagged ? ` · ⚠️ ${flagged} flagged for a look` : ""}`,
      "Review each story below: approve, edit, rewrite, swap or drop. Then tap <b>Confirm</b> at the bottom.",
    ].join("\n"),
  );
  for (const item of live) {
    const { text, keyboard } = renderStory(item, live.length, false);
    const msg = await sendHtml(text, keyboard);
    await query("update issue_items set telegram_message_id = $2 where id = $1", [item.id, msg.message_id]);
  }
  const control = renderControl(issue, items);
  const msg = await sendHtml(control.text, control.keyboard);
  await query("update issues set telegram_control_message_id = $2 where id = $1", [issue.id, msg.message_id]);
  await logEvent("delivered_to_telegram", { stories: live.length }, issue.id);
  return { delivered: true, issue: issue.id, stories: live.length };
}

/** Wednesday 10 PM IST: nudge Shreya if she hasn't confirmed. Never sends the newsletter. */
export async function sendReminder(week = weekStart()) {
  await loadRubric();
  const [issue] = await query<Issue>(`select ${ISSUE_COLUMNS} from issues where week_start = $1`, [week]);
  if (!issue) return { reminded: false, reason: "no issue this week" };
  if (issue.status === "drafted") await deliverDraft(week);
  if (!["drafted", "in_review"].includes(issue.status)) return { reminded: false, reason: `issue is ${issue.status}` };
  if (issue.reminder_sent_at) return { reminded: false, reason: "reminder already sent" };

  const items = await loadItems(issue.id);
  const live = active(items);
  const pending = live.filter((i) => i.status === "pending").length;
  await sendHtml(
    [
      `⏰ <b>Reminder: The Dispatch #${issue.issue_number} is waiting for you.</b>`,
      `${live.length - pending} of ${live.length} stories approved, ${pending} pending.`,
      `It is scheduled for <b>${formatIst(sendTimeFor(week))}</b> but <b>will not go out until you confirm.</b>`,
    ].join("\n"),
    [[button("✅ Approve all pending", `aa:${issue.id}`)], [button("📬 Confirm final draft", `cf:${issue.id}`)]],
    issue.telegram_control_message_id ? { reply_parameters: { message_id: Number(issue.telegram_control_message_id), allow_sending_without_reply: true } } : {},
  );
  await query("update issues set reminder_sent_at = now() where id = $1", [issue.id]);
  await logEvent("reminder_sent", { pending }, issue.id);
  return { reminded: true, pending };
}

// ---------------------------------------------------------------- update handling

async function answer(cb: TgCallbackQuery, text?: string, alert = false) {
  // Callback answers expire after a while; a stale one must not abort the action itself.
  await tg("answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text, show_alert: alert } : {}) }).catch((err) =>
    console.warn("answerCallbackQuery:", (err as Error).message),
  );
}

async function handleCallback(cb: TgCallbackQuery) {
  if (cb.message?.chat.id !== chatId()) return answer(cb);
  if (cb.from.id !== adminId()) return answer(cb, "Only Shreya can review this draft.", true);

  const [action, a, b] = (cb.data ?? "").split(":");
  const id = Number(a);

  // Early look (Mon/Tue): pin or block a story before the draft exists.
  if (action === "el") {
    const r = await handleEarlyLookTap(cb, a, Number(b));
    return answer(cb, r.message, !r.ok);
  }

  // Issue-level actions
  if (["aa", "cf", "cy", "cn", "ro", "te", "sn"].includes(action)) {
    const issue = await getIssue(id);
    if (!issue) return answer(cb, "Issue not found.", true);

    if (action === "te") {
      if (!emailConfigured()) return answer(cb, "Gmail isn't configured yet.", true);
      await answer(cb, "Sending a test email…");
      try {
        const { to } = await sendTestEmail(id);
        await sendHtml(`📧 Test email for #${issue.issue_number} sent to ${esc(to)}. Only you got it.`);
      } catch (err) {
        await sendHtml(`⚠️ Test email failed: ${esc((err as Error).message)}`);
      }
      return;
    }
    if (action === "sn") {
      // Explicit tap after confirmation, used when she confirms after the scheduled Thursday slot.
      if (issue.status !== "confirmed") return answer(cb, `This issue is ${issue.status}.`, true);
      await answer(cb, "Sending now…");
      await logEvent("send_now_requested", { by: cb.from.id }, id);
      await triggerJob("/api/cron/send");
      await sendHtml(`🚀 Sending The Dispatch #${issue.issue_number} now. I'll post here when it's done.`);
      return;
    }

    if (action === "ro") {
      const r = await reopenIssue(id);
      if (!r.ok) return answer(cb, r.message, true);
      await refreshAll(id);
      return answer(cb, r.message);
    }
    if (issue.status !== "in_review") return answer(cb, `This draft is ${issue.status}.`, true);

    if (action === "aa") {
      const r = await approveAll(id);
      await refreshAll(id);
      return answer(cb, r.message, !r.ok);
    }
    if (action === "cf") {
      const items = await loadItems(id);
      const { checklist, ready } = readiness((await getEditorIssue(id))!, await loadEditorItems(id));
      if (!ready) {
        const missing = checklist.filter((c) => !c.ok).map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ""}`);
        return answer(cb, `Not ready yet: ${missing.join("; ")}. Tip: "Approve all pending" approves everything at once.`, true);
      }
      const [{ subscribers }] = await query<{ subscribers: number }>("select count(*)::int as subscribers from subscribers where status = 'active' and not is_sample");
      await answer(cb);
      await sendHtml(
        `📬 <b>Send The Dispatch #${issue.issue_number}?</b>\n${active(items).length} stories to <b>${subscribers}</b> active subscribers on <b>${formatIst(sendTimeFor(issue.week_start))}</b>.\nYou can still reopen it before then.`,
        [[button("✅ Yes, confirm and schedule", `cy:${id}`), button("Cancel", `cn:${id}`)]],
      );
      return;
    }
    if (action === "cn") {
      await answer(cb, "Not confirmed. The draft is still open.");
      if (cb.message) await tg("deleteMessage", { chat_id: chatId(), message_id: cb.message.message_id }).catch(() => {});
      return;
    }
    if (action === "cy") {
      // confirmIssue re-checks everything at the moment of confirmation.
      const r = await confirmIssue(id, cb.from.id, "telegram");
      if (!r.ok) return answer(cb, r.message, true);
      await answer(cb, "Confirmed.");
      const late = Date.now() >= sendTimeFor(issue.week_start).getTime();
      if (cb.message) {
        await editHtml(
          cb.message.message_id,
          late
            ? `✅ <b>Confirmed.</b> The scheduled time has passed, so tap <b>🚀 Send now</b> on the review panel when you're ready.`
            : `✅ <b>Confirmed.</b> The Dispatch #${issue.issue_number} goes out ${esc(formatIst(sendTimeFor(issue.week_start)))}.`,
        );
      }
      await refreshAll(id);
      return;
    }
  }

  // Story-level actions
  const item = await getItem(id);
  if (!item) return answer(cb, "Story not found.", true);
  const issue = (await getIssue(item.issue_id))!;
  if (issue.status !== "in_review") return answer(cb, issue.status === "confirmed" ? "The draft is confirmed and locked. Tap Reopen to make changes." : `This draft is ${issue.status}.`, true);

  switch (action) {
    case "ap":
    case "un":
    case "dr":
    case "rs": {
      const next = ({ ap: "approved", un: "pending", dr: "dropped", rs: "pending" } as const)[action];
      const r = await setItemStatus(item.id, next);
      if (!r.ok) return answer(cb, r.message, true);
      await refreshStory({ ...item, status: next }, issue, await loadItems(issue.id));
      await refreshControl(issue);
      return answer(cb, r.message);
    }

    case "ed": {
      await answer(cb);
      await tg("sendMessage", {
        chat_id: chatId(),
        text: `✏️ Editing #${item.position} (ref ${item.id}): ${item.headline}\n\nReply to this message with the new commentary, or reply "/ai <instruction>" to have Gemini rewrite it (e.g. /ai make it punchier).\n\nCurrent:\n${item.commentary}`,
        // Not "selective": that would target the sender of the replied-to message (the bot itself).
        reply_markup: { force_reply: true, input_field_placeholder: "New commentary…" },
      });
      return;
    }

    case "rw": {
      await answer(cb, "Rewriting with Gemini…");
      return rewriteAndRefresh(item, issue);
    }

    case "sw": {
      const items = await loadItems(issue.id);
      const options = items.filter((i) => i.role === "bench" && i.status === "pending").slice(0, 6);
      if (!options.length) return answer(cb, "No bench stories left to swap in.", true);
      await answer(cb);
      await sendHtml(
        `🔁 Swap out <b>#${item.position}</b> “${esc(truncate(item.headline, 80))}” for:`,
        [
          ...options.map((o) => [button(`${truncate(TOPICS[o.topic] ?? o.topic, 18)} · ${truncate(o.headline, 45)}`, `sp:${item.id}:${o.id}`)]),
          [button("Cancel", `sx:${item.id}`)],
        ],
      );
      return;
    }

    case "sx": {
      await answer(cb);
      if (cb.message) await tg("deleteMessage", { chat_id: chatId(), message_id: cb.message.message_id }).catch(() => {});
      return;
    }

    case "sp": {
      const r = await swapIn(item.id, Number(b));
      if (!r.ok) return answer(cb, r.message, true);
      await answer(cb, "Swapped.");
      if (cb.message) await tg("deleteMessage", { chat_id: chatId(), message_id: cb.message.message_id }).catch(() => {});
      // Re-renders the swapped-out story and posts the swapped-in one (it has no message yet).
      await refreshAll(issue.id);
      return;
    }
  }
  return answer(cb);
}

async function rewriteAndRefresh(item: Item, issue: Issue, instruction?: string) {
  try {
    const { failures } = await rewriteCommentary(item.id, instruction);
    const items = await loadItems(issue.id);
    await refreshStory(items.find((i) => i.id === item.id)!, issue, items);
    if (failures.length) await sendHtml(`♻️ Rewrote #${item.position}, but heads-up: ${esc(failures.join("; "))}`);
  } catch (err) {
    console.error(err);
    await sendHtml(`⚠️ Couldn't rewrite #${item.position}: Gemini is busy or out of free quota. Try again later, or use ✏️ Edit to write it yourself.`);
  }
}

/** Shreya replying to an "✏️ Editing" prompt. */
async function handleEditReply(msg: TgMessage) {
  const ref = /\(ref (\d+)\)/.exec(msg.reply_to_message?.text ?? "")?.[1];
  if (!ref || !msg.text) return;
  const item = await getItem(Number(ref));
  if (!item) return;
  const issue = (await getIssue(item.issue_id))!;
  if (issue.status !== "in_review") {
    await sendHtml("This draft is locked (confirmed). Tap ⏪ Reopen first, then edit.");
    return;
  }

  const text = msg.text.trim();
  if (text.startsWith("/ai")) {
    await rewriteAndRefresh(item, issue, text.replace(/^\/ai(@\w+)?\s*/, "") || undefined);
    return;
  }

  // Her words win: saved as-is and approved; rule issues are only a heads-up.
  const r = await saveCommentary(item.id, text);
  const items = await loadItems(issue.id);
  await refreshStory(items.find((i) => i.id === item.id)!, issue, items);
  await refreshControl(issue);
  await tg("sendMessage", {
    chat_id: chatId(),
    text: `#${item.position}: ${r.message}`,
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
  });
}

/** "/add <link> [headline]", or just a link on its own: a story the feeds missed. */
async function handleAdd(text: string) {
  const [link, ...rest] = text.trim().split(/\s+/);
  if (!link || !/^https?:\/\//i.test(link)) {
    return sendHtml("Send <code>/add &lt;link&gt;</code>, optionally followed by the headline (needed for paywalled pages and X posts).");
  }
  await sendHtml(`➕ Reading ${esc(truncate(link, 80))}…`);
  try {
    const r = await addStoryFromLink(link, rest.join(" ") || undefined);
    await sendHtml(`${r.ok ? "✅" : "⚠️"} ${esc(r.message)}`);
  } catch (err) {
    console.error("add from link failed", err);
    await sendHtml(`⚠️ Couldn't add that story: ${esc((err as Error).message)}`);
  }
}

async function handleCommand(msg: TgMessage) {
  const command = (msg.text ?? "").split(/[\s@]/)[0];
  if (command === "/add") return handleAdd((msg.text ?? "").replace(/^\/add(@\w+)?/, ""));
  if (command === "/status") {
    const issue = await currentIssue();
    if (!issue) return sendHtml("No issue yet this week.");
    const { text } = renderControl(issue, await loadItems(issue.id));
    return sendHtml(text);
  }
  if (command === "/help" || command === "/start") {
    return sendHtml(
      "I draft The Dispatch every Wednesday evening and post it here for review.\n\n" +
        "Each story has buttons to <b>approve</b>, <b>edit</b>, <b>rewrite</b> (Gemini), <b>swap</b> (from the bench) or <b>drop</b>. " +
        "Nothing is emailed until you tap <b>Confirm</b>; if you haven't by 10 PM Wednesday I'll remind you.\n\n" +
        "On Monday and Tuesday evenings I post an <b>early look</b> at the strongest stories so far: 📌 pins one into Wednesday's draft, 🚫 keeps one out.\n\n" +
        "/add &lt;link&gt; [headline]: add a story the feeds missed (or just paste the link)\n/status: where this week's issue stands",
    );
  }
}

/** Entry point for every Telegram update (webhook in production, long-polling locally). */
export async function handleUpdate(update: TgUpdate) {
  await loadRubric();
  if (update.callback_query) return handleCallback(update.callback_query);
  const msg = update.message;
  if (!msg || msg.chat.id !== chatId() || msg.from?.id !== adminId()) return;
  if (msg.reply_to_message?.text?.includes("(ref ")) return handleEditReply(msg);
  if (msg.text?.startsWith("/")) return handleCommand(msg);
  if (/^https?:\/\/\S+/i.test(msg.text?.trim() ?? "")) return handleAdd(msg.text!);
}
