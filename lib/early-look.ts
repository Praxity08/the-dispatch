// Monday and Tuesday evenings: a short Telegram preview of the strongest stories so far, so Shreya can
// pin a story (it must be in Wednesday's draft) or block one (it never will be) before the draft exists.
import { logEvent, query } from "./db";
import { loadCovered, scoreNewStories } from "./draft";
import { flagStory, type Result } from "./editor";
import { appUrl } from "./env";
import { button, chatId, editHtml, esc, type InlineKeyboard, sendHtml, tg, type TgCallbackQuery } from "./telegram";
import { truncate } from "./text";
import { TOPICS, type Topic } from "./topics";
import { weekStart } from "./week";

const TOP_N = 5;

type Story = { id: number; headline: string; topic: Topic | null; score: number | null; reason: string | null; url: string; editor_flag: "pin" | "block" | null };

const istDate = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const istWeekday = () => new Intl.DateTimeFormat("en-IN", { weekday: "long", timeZone: "Asia/Kolkata" }).format(new Date());

async function loadStories(week: string, ids?: number[]): Promise<Story[]> {
  return query<Story>(
    `select s.id, s.headline, s.topic, s.score, s.scores->>'reason' as reason, s.editor_flag,
            (array_agg(a.url order by (a.url like 'https://news.google.com/%'), a.id))[1] as url
     from stories s join articles a on a.story_id = s.id
     where a.week_start = $1 and a.is_relevant and ($2::bigint[] is null or s.id = any($2::bigint[]))
     group by s.id order by s.score desc nulls last`,
    [week, ids ?? null],
  );
}

/** The top stories still in contention (not covered recently, not blocked), plus everything she pinned. */
async function pickStories(week: string): Promise<{ top: Story[]; pinned: Story[]; total: number }> {
  const covered = new Set((await loadCovered(week)).map((c) => c.id));
  const all = (await loadStories(week)).filter((s) => !covered.has(Number(s.id)));
  const top = all.filter((s) => s.score != null && s.editor_flag !== "block").slice(0, TOP_N);
  const pinned = all.filter((s) => s.editor_flag === "pin" && !top.some((t) => t.id === s.id));
  return { top, pinned, total: all.length };
}

function render(label: string, stories: Story[], pinnedElsewhere: number, total: number): { text: string; keyboard: InlineKeyboard } {
  const lines = stories.map((s, i) => {
    const mark = s.editor_flag === "pin" ? " 📌" : s.editor_flag === "block" ? " 🚫" : "";
    const meta = [s.score == null ? "unscored" : `${Math.round(Number(s.score))}/100`, s.topic ? TOPICS[s.topic] : null].filter(Boolean).join(" · ");
    return `<b>${i + 1}.</b> <a href="${esc(s.url)}">${esc(truncate(s.headline, 110))}</a>${mark}\n<i>${esc(meta)}</i>${s.reason ? ` · ${esc(truncate(s.reason, 120))}` : ""}`;
  });
  const footer = [
    pinnedElsewhere ? `📌 ${pinnedElsewhere} more ${pinnedElsewhere === 1 ? "story is" : "stories are"} pinned.` : "",
    "📌 = must be in Wednesday's draft · 🚫 = keep it out. Spotted something the feeds missed? Send <code>/add &lt;link&gt;</code>.",
  ].filter(Boolean);
  const text = `🔭 <b>Early look · ${esc(label)}</b>\nThe ${stories.length} strongest of ${total} stories so far this week.\n\n${lines.join("\n\n")}\n\n${footer.join("\n")}`;
  const keyboard: InlineKeyboard = stories.map((s, i) => [
    s.editor_flag === "pin" ? button(`${i + 1} · Unpin`, `el:clear:${s.id}`) : button(`📌 ${i + 1}`, `el:pin:${s.id}`),
    s.editor_flag === "block" ? button(`${i + 1} · Unblock`, `el:clear:${s.id}`) : button(`🚫 ${i + 1}`, `el:block:${s.id}`),
  ]);
  if (process.env.APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL) keyboard.push([{ text: "Open the story pool", url: `${appUrl()}/admin?tab=pool` }]);
  return { text, keyboard };
}

/**
 * Posts the early look. Once per day unless forced (the dashboard button). Scores any new stories first,
 * within the time budget, so the ranking is current. Never runs once the week's draft exists.
 */
export async function sendEarlyLook({ budgetMs = 120_000, force = false, preview = false } = {}) {
  const week = weekStart();
  const [issue] = await query<{ status: string }>("select status from issues where week_start = $1", [week]);
  // `preview` (CLI only) shows the message even after the draft exists, for testing.
  if (issue && issue.status !== "collecting" && !preview) return { skipped: `this week's issue is already ${issue.status}` };
  const today = istDate();
  if (!force && !preview) {
    const [sent] = await query("select 1 from events where kind = 'early_look' and payload->>'date' = $1", [today]);
    if (sent) return { skipped: "already sent today" };
  }

  let scoring: unknown = null;
  try {
    scoring = await scoreNewStories({ budgetMs, week });
  } catch (err) {
    scoring = { error: (err as Error).message }; // out of Gemini quota: preview with what is already scored
  }
  const { top, pinned, total } = await pickStories(week);
  if (!top.length) return { skipped: "no scored stories yet", scoring };

  const { text, keyboard } = render(preview ? `${istWeekday()} (preview)` : istWeekday(), top, pinned.length, total);
  const msg = await sendHtml(text, keyboard);
  await logEvent("early_look", { date: today, week, stories: top.map((s) => Number(s.id)), message: msg.message_id, scoring });
  return { sent: top.length, pinned: pinned.length, total, scoring };
}

/** A 📌 / 🚫 tap on the early-look message: records the call and redraws the message in place. */
export async function handleEarlyLookTap(cb: TgCallbackQuery, op: string, storyId: number): Promise<Result> {
  const flag = op === "pin" ? "pin" : op === "block" ? "block" : null;
  const result = await flagStory(storyId, flag);
  const message = cb.message;
  if (!result.ok || !message) return result;

  // The story ids on the message are the source of truth for which stories it shows.
  const ids = (message.reply_markup?.inline_keyboard ?? [])
    .map((row) => row[0])
    .map((b) => ("callback_data" in b ? Number(b.callback_data.split(":")[2]) : NaN))
    .filter((id) => Number.isFinite(id));
  const week = weekStart();
  const byId = new Map((await loadStories(week, ids)).map((s) => [Number(s.id), s]));
  const stories = ids.map((id) => byId.get(id)).filter((s): s is Story => !!s);
  const { pinned, total } = await pickStories(week);
  const label = /Early look · ([^\n<]+)/.exec(message.text ?? "")?.[1]?.trim() ?? istWeekday();
  const { text, keyboard } = render(label, stories, pinned.filter((p) => !ids.includes(Number(p.id))).length, total);
  await editHtml(message.message_id, text, keyboard).catch(async () => {
    // Message too old to edit: post a fresh copy.
    await tg("deleteMessage", { chat_id: chatId(), message_id: message.message_id }).catch(() => {});
    await sendHtml(text, keyboard);
  });
  return result;
}
