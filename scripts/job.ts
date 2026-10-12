// Run a pipeline step locally:  npm run job ingest
import { ingestAll } from "../lib/ingest";
import { processWeek, reclusterWeek } from "../lib/process";
import { seedStyleGuide } from "../lib/style";
import { draftIssue, scoreNewStories } from "../lib/draft";
import { sendEarlyLook } from "../lib/early-look";
import { addStoryFromLink } from "../lib/manual";
import { deliverDraft, refreshAll, sendReminder } from "../lib/review";
import { sendIssue, sendTestEmail } from "../lib/send";
import { processInbox } from "../lib/bounces";
import { appUrl } from "../lib/env";
import { tg } from "../lib/telegram";
import { query } from "../lib/db";

const jobs: Record<string, () => Promise<unknown>> = {
  ingest: ingestAll,
  process: () => processWeek(),
  prepare: () => processWeek({ cluster: false }), // screen + embed only
  recluster: () => reclusterWeek(),
  "seed-style": seedStyleGuide,
  draft: () => draftIssue(),
  score: () => scoreNewStories(),
  // --force: again today; --preview: even though this week's draft exists (testing)
  "early-look": () => sendEarlyLook({ force: process.argv.includes("--force"), preview: process.argv.includes("--preview") }),
  // npm run job add-link -- <url> [headline]
  "add-link": () => addStoryFromLink(process.argv[3] ?? "", process.argv.slice(4).join(" ") || undefined),
  deliver: () => deliverDraft(),
  remind: () => sendReminder(),
  send: () => sendIssue(),
  "refresh-telegram": async () => {
    const [issue] = await query<{ id: number }>("select id from issues order by week_start desc limit 1");
    await refreshAll(Number(issue.id));
    return { refreshed: issue.id };
  },
  bounces: () => processInbox(),
  "test-email": async () => {
    const [issue] = await query<{ id: number }>("select id from issues order by week_start desc limit 1");
    return sendTestEmail(Number(issue.id));
  },
  // Points Telegram at the deployed webhook (run once after deploying; stops local polling).
  "telegram-webhook": async () => {
    const url = `${appUrl()}/api/telegram`;
    await tg("setWebhook", {
      url,
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    await tg("setMyCommands", {
      commands: [
        { command: "add", description: "Add a story from a link: /add <link> [headline]" },
        { command: "status", description: "Where this week's issue stands" },
        { command: "help", description: "What I can do" },
      ],
    });
    return tg("getWebhookInfo");
  },
};

const name = process.argv[2];
const job = jobs[name];
if (!job) {
  console.error(`Usage: npm run job <${Object.keys(jobs).join("|")}>`);
  process.exit(1);
}

const started = Date.now();
job()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    console.log(`\n${name} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    process.exit(0); // the pooled SMTP connection would otherwise keep the process alive
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
