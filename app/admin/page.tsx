import Link from "next/link";
import { isRubricUnlocked, RUBRIC_UNLOCK_MINUTES_LABEL, requireAdmin, samplePasswords } from "@/lib/admin";
import { query } from "@/lib/db";
import { editExamples } from "@/lib/draft";
import { EDITABLE, type EditorIssue, type EditorItem, isLive, latestIssue, loadEditorItems, readiness } from "@/lib/editor";
import { emailConfigured } from "@/lib/email";
import { COMMENTARY, CRITERIA, CRITERION_KEYS, type Criterion, criterionPoints, SCORING, SELECTION, snapshotRubric, UNDER_REPORTED_SCALE } from "@/lib/rubric";
import { loadRubric, rubricHistory } from "@/lib/rubric-store";
import { getStyleGuide } from "@/lib/style";
import { TOPIC_KEYS, TOPICS, type Topic } from "@/lib/topics";
import { formatIst, sendTimeFor, weekStart } from "@/lib/week";
import { ThemeToggle } from "../theme-toggle";
import { lockRubric, logout, toggleSource } from "./actions";
import {
  ActionButton,
  AddLinkForm,
  AddSubscriberForm,
  CommentaryEditor,
  ConfirmPanel,
  IssueTextForm,
  JobButton,
  RedraftPanel,
  ReplyButton,
  RestoreDefaultsButton,
  RubricEditor,
  RubricUnlockForm,
  StyleGuideForm,
  SubscriberButton,
  type SwapOption,
  SwapPicker,
  TabPending,
} from "./forms";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Gemini rewrites run inside server actions

const TABS = [
  { key: "issue", label: "This week's issue" },
  { key: "pool", label: "Story pool" },
  { key: "subscribers", label: "Subscribers" },
  { key: "replies", label: "Reader replies" },
  { key: "guide", label: "Voice guide" },
  { key: "scoring", label: "How scoring works" },
  { key: "history", label: "Past issues" },
  { key: "pipeline", label: "Pipeline" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  collecting: { label: "Collecting stories", tone: "butter" },
  drafted: { label: "Draft ready", tone: "info" },
  in_review: { label: "In review", tone: "info" },
  confirmed: { label: "Confirmed · scheduled", tone: "good" },
  sending: { label: "Sending…", tone: "good" },
  sent: { label: "Sent", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
};

const fmt = (d: string | null) => (d ? formatIst(new Date(d)) : "—");

/** Pastel per topic (design tokens in dispatch-theme.css); unlisted topics stay neutral. */
const TOPIC_TONE: Partial<Record<Topic, string>> = {
  policy_regulation: "blue",
  saas_enterprise: "blue",
  commerce_d2c: "sand",
  people_governance: "lav",
  ai_deeptech: "lav",
  ipo_markets: "butter",
  funding_vc: "green",
  mobility_climate: "green",
  fintech: "rose",
};
const topicChip = (topic: Topic | null | undefined) => `chip topic tone-${(topic && TOPIC_TONE[topic]) || "neutral"}`;

/** Plain copy of the live commentary limits for the browser-side checks. */
const liveLimits = () => ({
  minSentences: COMMENTARY.minSentences,
  maxSentences: COMMENTARY.maxSentences,
  minWords: COMMENTARY.minWords,
  maxWords: COMMENTARY.maxWords,
});

const STATUS_STEPS = [
  { key: "collecting", label: "Collecting" },
  { key: "drafted", label: "Drafted" },
  { key: "in_review", label: "In review" },
  { key: "confirmed", label: "Confirmed" },
  { key: "sending", label: "Sending" },
  { key: "sent", label: "Sent" },
];

type Props = { searchParams: Promise<{ tab?: string; topic?: string; status?: string; view?: string }> };

export default async function EditorDashboard({ searchParams }: Props) {
  await requireAdmin();
  await loadRubric();
  const params = await searchParams;
  const tab: Tab = (TABS.find((t) => t.key === params.tab)?.key ?? "issue") as Tab;
  const issue = await latestIssue();
  const [{ unread }] = await query<{ unread: number }>("select count(*)::int as unread from reader_replies where status = 'new'");

  const today = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" }).format(new Date());
  const stepIndex = issue ? STATUS_STEPS.findIndex((x) => x.key === issue.status) : -1;

  return (
    <main className="dash">
      <aside className="dash-side">
        <div className="side-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="dash-logo" src="/dispatch-logo.png" alt="The Dispatch — India's startup brief" />
          <span className="editor-chip">Editor</span>
        </div>
        {issue && <IssueStrip issue={issue} />}
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <Link key={t.key} href={`/admin?tab=${t.key}`} className={t.key === tab ? "active" : ""} aria-current={t.key === tab ? "page" : undefined}>
              <span className="tab-label">{t.label}</span>
              <TabPending />
              {t.key === "replies" && unread > 0 && <span className="badge" aria-label={`${unread} unread`}>{unread}</span>}
            </Link>
          ))}
        </nav>
        <ThemeToggle />
        <div className="side-foot">
          <span>Signed in as Shreya</span>
          <form action={logout}><button className="link-btn">Log out</button></form>
        </div>
      </aside>

      <div className="dash-main">
        <header className="dash-head">
          <div>
            <p className="today">{today}</p>
            <h1>Good to see you, Shreya</h1>
          </div>
          {issue && (
            <ol className="steps progress" aria-label="Issue progress">
              {STATUS_STEPS.map((step, i) => {
                const done = i < stepIndex || issue.status === "sent";
                const current = i === stepIndex && issue.status !== "sent";
                return (
                  <li key={step.key} className={done ? "done" : current ? "current" : ""} aria-current={current ? "step" : undefined}>
                    {done ? "✓ " : current ? "● " : ""}{step.label}
                  </li>
                );
              })}
            </ol>
          )}
        </header>

      {/* Keyed by tab, so each switch remounts the panel and plays its entrance. */}
      <div className="tab-panel" key={tab}>
      {tab === "issue" && <IssueTab issue={issue} />}
      {tab === "pool" && <PoolTab issue={issue} topic={params.topic} />}
      {tab === "subscribers" && <SubscribersTab status={params.status} />}
      {tab === "replies" && <RepliesTab view={params.view} />}
      {tab === "guide" && <GuideTab />}
      {tab === "scoring" && <ScoringTab issue={issue} />}
      {tab === "history" && <HistoryTab />}
      {tab === "pipeline" && <PipelineTab />}
      </div>
      </div>
    </main>
  );
}

function IssueStrip({ issue }: { issue: EditorIssue }) {
  const s = STATUS_COPY[issue.status] ?? { label: issue.status, tone: "neutral" };
  const sendAt = sendTimeFor(issue.week_start);
  const remindAt = new Date(sendAt.getTime() - 10 * 3600 * 1000);
  return (
    <div className={`strip tone-${s.tone}`}>
      <div className="strip-status"><span className="dot" aria-hidden="true" />{s.label} · #{issue.issue_number}</div>
      <div className="strip-lines">
        {EDITABLE.includes(issue.status) && <span>Confirm before {formatIst(remindAt)}</span>}
        {issue.status !== "sent" && <span>Sends {formatIst(sendAt)}</span>}
        {issue.sent_at && <span>Sent {fmt(issue.sent_at)}</span>}
      </div>
    </div>
  );
}

// ================================================================ This week's issue

async function IssueTab({ issue }: { issue: EditorIssue | undefined }) {
  if (!issue || issue.status === "collecting") {
    const [{ stories }] = await query<{ stories: number }>("select count(*)::int as stories from stories where week_start = $1", [weekStart()]);
    return (
      <section className="empty">
        <span className="chip warn">Collecting · {stories} stories so far</span>
        <h2>No draft yet</h2>
        <p className="muted">
          The engine reads the sources Monday to Wednesday and drafts the issue on Wednesday at 2 PM. You&apos;ll get it in Telegram at 6 PM, and it
          shows up here at the same time.
        </p>
        {issue?.status === "collecting" && (
          <p className="muted small">If you just started a fresh draft, it&apos;s being written now. Refresh in a few minutes.</p>
        )}
        <JobButton job="draft" label="Draft this week's issue now" hint="Scores every story, picks 8–10 and writes commentary (takes a few minutes)" />
        <p className="muted small">
          Until then you can steer it: pin or block stories in the <Link href="/admin?tab=pool">story pool</Link> (the Monday and Tuesday early look in
          Telegram does the same), or add a story the feeds missed.
        </p>
        <AddLinkForm hint="It's deduped against this week's stories, scored, and pinned so Wednesday's draft includes it." />
      </section>
    );
  }

  const items = await loadEditorItems(issue.id);
  const { checklist, ready, flagged, live } = readiness(issue, items);
  const locked = !EDITABLE.includes(issue.status);
  const lineup = items.filter(isLive).sort((a, b) => a.position - b.position);
  const removed = items.filter((i) => i.role === "selected" && !isLive(i));
  const bench = items.filter((i) => i.role === "bench" && i.status === "pending");
  const SHORT: Record<Criterion, string> = {
    signal: "Sig",
    counterintuitive: "Ctr",
    under_reported: "Und",
    connects: "Conn",
    india: "India",
    commentary_potential: "Take",
  };
  const swapOptions: SwapOption[] = bench
    .filter((b) => b.commentary.trim())
    .map((b) => ({
      id: b.id,
      headline: b.headline,
      topic: TOPICS[b.topic] ?? b.topic,
      score: Math.round(Number(b.score ?? 0)),
      outlets: new Set(b.publishers).size,
      criteria: b.criteria
        ? CRITERION_KEYS.map((k) => ({ label: SHORT[k], name: CRITERIA[k].label, score: b.criteria![k], points: criterionPoints(k, b.criteria![k]) }))
        : [],
    }))
    .sort((a, b) => b.score - a.score);
  const [{ subscribers }] = await query<{ subscribers: number }>("select count(*)::int as subscribers from subscribers where status = 'active'");
  const sendAt = sendTimeFor(issue.week_start);
  const late = Date.now() >= sendAt.getTime();
  const topics = new Set(lineup.map((i) => i.topic)).size;

  const [pipeline] = await query<{ articles: number; relevant: number; stories: number; scored: number }>(
    `select (select count(*)::int from articles where week_start = $1) as articles,
            (select count(*)::int from articles where week_start = $1 and is_relevant) as relevant,
            (select count(*)::int from stories where week_start = $1) as stories,
            (select count(*)::int from stories where week_start = $1 and scored_at is not null) as scored`,
    [issue.week_start],
  );
  return (
    <>
      <div className="stats overview">
        <div className="stat"><b>{pipeline.articles}</b><span className="muted">articles read</span></div>
        <div className="stat"><b>{pipeline.relevant}</b><span className="muted">relevant</span></div>
        <div className="stat"><b>{pipeline.stories}</b><span className="muted">distinct stories</span></div>
        <div className="stat"><b>{pipeline.scored}</b><span className="muted">scored</span></div>
        <Link href="/admin?tab=subscribers" className="stat"><b>{subscribers}</b><span className="muted">active subscribers</span></Link>
      </div>
    <div className="issue-layout">
      <div className="issue-main">
        <section>
          <div className="section-head">
            <h2>Lineup <span className="muted">· {live} stories · {topics} topics{flagged ? ` · ⚠ ${flagged} flagged` : ""}</span></h2>
            {!locked && lineup.some((i) => i.status === "pending") && (
              <ActionButton op="approve-all" fields={{ issue: issue.id }} label="Approve all pending" pendingLabel="Approving…" variant="good" />
            )}
          </div>
          {lineup.map((item, idx) => (
            <StoryCard key={item.id} item={item} issueId={issue.id} locked={locked} first={idx === 0} last={idx === lineup.length - 1} swapOptions={swapOptions} />
          ))}
        </section>

        {removed.length > 0 && (
          <section>
            <h2>Removed from this issue</h2>
            {removed.map((item) => (
              <div key={item.id} className="card removed">
                <div className="card-top">
                  <span className="chip">{item.status === "dropped" ? "Dropped" : "Swapped out"}</span>
                  <a href={item.url} target="_blank" rel="noreferrer" className="removed-title">{item.headline}</a>
                </div>
                {item.status === "dropped" && !locked && <ActionButton op="restore" fields={{ item: item.id, issue: issue.id }} label="Restore" />}
                {item.status === "swapped_out" && !locked && lineup.some((l) => l.id === Number(item.swapped_for)) && (
                  <ActionButton op="undo-swap" fields={{ item: item.id, issue: issue.id }} label="Undo swap" pendingLabel="Undoing…" />
                )}
              </div>
            ))}
          </section>
        )}

        <section>
          <div className="section-head">
            <h2>Bench <span className="muted">· swap options</span></h2>
            <Link href="/admin?tab=pool" className="small">Find more in the story pool →</Link>
          </div>
          <p className="muted small">The next-best stories. Edit their commentary here, then use “Swap” on a lineup story to bring one in.</p>
          <div className="bench-list">
            {!locked && <AddLinkForm hint="Saw something the feeds missed? It's scored, gets a draft commentary in your voice, and lands here on the bench." />}
            {bench.map((item) => (
              <BenchCard key={item.id} item={item} issueId={issue.id} locked={locked} />
            ))}
            {bench.length === 0 && <p className="muted small">The bench is empty.</p>}
          </div>
        </section>
      </div>

      <aside className="issue-side">
        <section className="panel">
          <h3>Send</h3>
          {EDITABLE.includes(issue.status) && (
            <>
              <ul className="checklist">
                {checklist.map((c) => (
                  <li key={c.label} className={c.ok ? "ok" : "todo"}>
                    <span aria-hidden="true">{c.ok ? "✓" : "○"}</span>
                    <span>{c.label}{c.detail && <span className="muted small">{c.detail}</span>}</span>
                  </li>
                ))}
              </ul>
              <ConfirmPanel
                issueId={issue.id}
                ready={ready}
                summary={`${live} stories go to ${subscribers} active subscribers ${late ? "as soon as you tap Send now" : `on ${formatIst(sendAt)}`}.`}
              />
              {subscribers === 0 && (
                <p className="warn small">⚠ There are no active subscribers yet. <Link href="/admin?tab=subscribers">Add some</Link> before Thursday.</p>
              )}
              <p className="muted small">Nothing is emailed until you confirm, here or in Telegram.</p>
            </>
          )}
          {issue.status === "confirmed" && (
            <>
              <p>✅ Confirmed {fmt(issue.confirmed_at)}.</p>
              <p>{late ? <b>The scheduled time has passed.</b> : <>Goes to <b>{subscribers}</b> subscribers on <b>{formatIst(sendAt)}</b>.</>}</p>
              {late && <ActionButton op="send-now" fields={{ issue: issue.id }} label="Send now" variant="primary" pendingLabel="Starting…" />}
              <ActionButton op="reopen" fields={{ issue: issue.id }} label="Reopen for edits" />
            </>
          )}
          {(issue.status === "sending" || issue.status === "sent") && <DeliveryStats issueId={issue.id} />}
          <div className="side-links">
            <a href="/admin/preview" target="_blank" className="btn secondary">Preview email</a>
            {emailConfigured() ? (
              <ActionButton op="test-email" fields={{ issue: issue.id }} label="Send test to me" pendingLabel="Sending…" />
            ) : (
              <span className="action">
                <button className="btn secondary" disabled title="Add the Gmail app password to enable">Send test to me</button>
                <span className="muted small">Needs the Gmail app password</span>
              </span>
            )}
          </div>
        </section>

        <section className="panel">
          <h3>Subject &amp; opening</h3>
          <IssueTextForm issueId={issue.id} subject={issue.subject ?? ""} intro={issue.intro ?? ""} locked={locked} />
        </section>

        <section className="panel">
          <h3>Timeline</h3>
          <ul className="timeline">
            {[
              { label: "Drafted", at: issue.drafted_at },
              { label: "Sent to Telegram", at: issue.delivered_at },
              { label: "Reminder", at: issue.reminder_sent_at },
              { label: "Confirmed", at: issue.confirmed_at },
              { label: "Scheduled send", at: sendAt.toISOString(), always: true },
              { label: "Emailed", at: issue.sent_at },
            ].map((t) => (
              <li key={t.label} className={t.at ? "done" : ""}>
                <span>{t.label}</span>
                <span className="time">{t.always ? formatIst(sendAt) : fmt(t.at)}</span>
              </li>
            ))}
          </ul>
        </section>

        {!locked && (
          <section className="panel redraft">
            <h3>Not happy with this draft?</h3>
            <p className="muted small">Have the engine re-analyse every story this week and draft the issue again from scratch.</p>
            <RedraftPanel issueId={issue.id} edits={items.filter((i) => i.edited_by_shreya).length} />
          </section>
        )}
      </aside>
    </div>
    </>
  );
}

/** "review average 3.75 < 4: note" → "AI copy-editor gave it 3.8/5: note" */
function humanProblem(p: string): string {
  const m = /^review average ([\d.]+) < [\d.]+: (.*)$/.exec(p);
  if (m) return `The AI copy-editor rated it ${Number(m[1]).toFixed(1)}/5 — ${m[2]}`;
  return p.replace(/^not grounded in sources: /, "Possibly not backed by the sources — ");
}

function Score({ item }: { item: EditorItem }) {
  if (!item.criteria) return null;
  return (
    <details className="rubric">
      <summary>Why it was picked <span className="chip warn">score {Math.round(Number(item.score ?? 0))}/100</span></summary>
      <p className="reason">{item.reason}</p>
      <div className="bars">
        {(Object.keys(CRITERIA) as Criterion[]).map((k) => (
          <div key={k} className="bar-row points" title={`${CRITERIA[k].question}\n0 = ${CRITERIA[k].anchors[0]} · 3 = ${CRITERIA[k].anchors[3]} · 5 = ${CRITERIA[k].anchors[5]}`}>
            <span>{CRITERIA[k].label} <span className="muted">· {Math.round(CRITERIA[k].weight * 100)}%</span></span>
            <span className="bar" aria-label={`${item.criteria![k]} out of 5`}>
              <span style={{ width: `${(item.criteria![k] / 5) * 100}%` }} />
            </span>
            <span className="num">{item.criteria![k]}/5</span>
            <span className="num muted">+{criterionPoints(k, item.criteria![k])}</span>
          </div>
        ))}
      </div>
      <p className="muted small">
        Points = weight × score ÷ 5. Hover a row to see what 0, 3 and 5 mean, or read <Link href="/admin?tab=scoring">how scoring works</Link>.
      </p>
      <p className="muted small">Covered by {new Set(item.publishers).size} outlet(s): {item.publishers.slice(0, 6).join(", ")}</p>
      {item.checks?.review && (
        <p className="muted small">
          AI copy-edit review: angle {item.checks.review.angle}/5 · voice {item.checks.review.voice}/5 · grounded {item.checks.review.grounded}/5 · forwardable{" "}
          {item.checks.review.forwardable}/5. {item.checks.review.note}
        </p>
      )}
    </details>
  );
}

function StoryCard({
  item,
  issueId,
  locked,
  first,
  last,
  swapOptions,
}: {
  item: EditorItem;
  issueId: number;
  locked: boolean;
  first: boolean;
  last: boolean;
  swapOptions: SwapOption[];
}) {
  const f = { item: item.id, issue: issueId };
  return (
    <article className={`card ${item.status}`}>
      <div className="card-top">
        <span className="pos">{item.position}</span>
        <span className={topicChip(item.topic)}>{TOPICS[item.topic] ?? item.topic}</span>
        <span className={`chip ${item.status === "approved" ? "good" : "warn"}`}>{item.status === "approved" ? "✓ Approved" : "○ Pending"}</span>
        {item.edited_by_shreya && <span className="chip">Edited by you</span>}
        {item.flagged && !item.edited_by_shreya && <span className="chip bad">⚠ Needs a look</span>}
        {!locked && (
          <span className="reorder">
            {!first && <ActionButton op="up" fields={f} label="↑" variant="ghost" title="Move up" />}
            {!last && <ActionButton op="down" fields={f} label="↓" variant="ghost" title="Move down" />}
          </span>
        )}
      </div>
      <h3 className="headline">
        <a href={item.url} target="_blank" rel="noreferrer">{item.headline}</a>
      </h3>
      <p className="muted small">via {item.publisher}</p>
      {item.flagged && !item.edited_by_shreya && item.checks?.problems?.length ? (
        <p className="flag-box">⚠ {item.checks.problems.map(humanProblem).join(" · ")}</p>
      ) : null}
      <CommentaryEditor
        itemId={item.id}
        issueId={issueId}
        headline={item.headline}
        initial={item.commentary}
        original={item.original_commentary}
        locked={locked}
        limits={liveLimits()}
      />
      <Score item={item} />
      {!locked && (
        <div className="card-actions">
          {item.status === "approved" ? (
            <ActionButton op="unapprove" fields={f} label="Unapprove" />
          ) : (
            <ActionButton op="approve" fields={f} label="Approve" variant="primary" pendingLabel="Approving…" />
          )}
          <ActionButton op="drop" fields={f} label="Drop" variant="danger" />
          <SwapPicker itemId={item.id} issueId={issueId} currentScore={Math.round(Number(item.score ?? 0))} bench={swapOptions} />
        </div>
      )}
    </article>
  );
}

function BenchCard({ item, issueId, locked }: { item: EditorItem; issueId: number; locked: boolean }) {
  return (
    <details className="card bench">
      <summary>
        <span className="num bench-score">{Math.round(Number(item.score ?? 0))}</span>
        <span className="bench-title">{item.headline}</span>
        {!item.commentary.trim() && <span className="chip warn">Needs commentary</span>}
        <span className={topicChip(item.topic)}>{TOPICS[item.topic] ?? item.topic}</span>
      </summary>
      <p className="muted small"><a href={item.url} target="_blank" rel="noreferrer">Read the source</a> · via {item.publisher} · {item.reason}</p>
      <CommentaryEditor itemId={item.id} issueId={issueId} headline={item.headline} initial={item.commentary} original={item.original_commentary} locked={locked} limits={liveLimits()} approves={false} />
    </details>
  );
}

async function DeliveryStats({ issueId }: { issueId: number }) {
  const [d] = await query<{ sent: number; failed: number; bounced: number; queued: number }>(
    `select count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'failed')::int as failed,
            count(*) filter (where status = 'bounced')::int as bounced, count(*) filter (where status = 'queued')::int as queued
     from deliveries where issue_id = $1`,
    [issueId],
  );
  return (
    <div className="stats compact">
      <div className="stat"><b>{d.sent}</b><span className="muted">delivered</span></div>
      <div className="stat"><b>{d.queued}</b><span className="muted">queued</span></div>
      <div className="stat"><b>{d.bounced}</b><span className="muted">bounced</span></div>
      <div className="stat"><b>{d.failed}</b><span className="muted">failed</span></div>
    </div>
  );
}

// ================================================================ Story pool

async function PoolTab({ issue, topic }: { issue: EditorIssue | undefined; topic?: string }) {
  const week = weekStart();
  const filterTopic = TOPIC_KEYS.includes(topic as Topic) ? (topic as Topic) : null;
  const stories = await query<{ id: number; headline: string; topic: Topic | null; score: number | null; reason: string | null; outlets: number; url: string; in_issue: string | null; editor_flag: "pin" | "block" | null; added: boolean }>(
    `select s.id, s.headline, s.topic, s.score, s.scores->>'reason' as reason, s.editor_flag, bool_or(a.added_by_shreya) as added,
            count(distinct lower(a.publisher))::int as outlets,
            (array_agg(a.url order by (a.url like 'https://news.google.com/%'), a.id))[1] as url,
            (select ii.role || ':' || ii.status from issue_items ii where ii.story_id = s.id and ii.issue_id = $2) as in_issue
     from stories s join articles a on a.story_id = s.id
     where a.week_start = $1 and a.is_relevant and ($3::text is null or s.topic = $3)
     group by s.id order by (s.editor_flag = 'pin') desc nulls last, s.score desc nulls last, count(*) desc limit 100`,
    [week, issue?.id ?? 0, filterTopic],
  );
  const editable = !!issue && EDITABLE.includes(issue.status);
  // Before this week's draft exists she steers selection with pins and blocks; afterwards, via the bench.
  const preDraft = !issue || issue.week_start !== week || issue.status === "collecting";
  const pinnedCount = stories.filter((s) => s.editor_flag === "pin").length;
  const [{ unscored }] = await query<{ unscored: number }>(
    `select count(distinct s.id)::int as unscored from stories s join articles a on a.story_id = s.id
     where a.week_start = $1 and a.is_relevant and s.scored_at is null`,
    [week],
  );
  return (
    <section>
      <h2 className="page-title">All stories this week</h2>
      <p className="muted small">
        {preDraft
          ? `Every distinct story the engine found, ranked by the editorial rubric. 📌 Pin a story to make sure Wednesday's draft includes it (up to ${SELECTION.max}), or 🚫 block one to keep it out.${pinnedCount ? ` ${pinnedCount} pinned so far.` : ""}`
          : "Every distinct story the engine found, ranked by the editorial rubric. Add any of them to the bench, then swap it into the lineup."}
      </p>
      {(preDraft || editable) && (
        <AddLinkForm hint={preDraft ? "Paste a story the feeds missed: it's deduped, scored and pinned for Wednesday." : "Paste a story the feeds missed: it's scored, gets draft commentary and goes on the bench."} />
      )}
      {unscored > 0 && (
        <div className="notice">
          <span><b>{unscored}</b> {unscored === 1 ? "story has" : "stories have"} arrived since the last scoring and {unscored === 1 ? "isn't" : "aren't"} ranked yet.</span>
          <JobButton job="score" label="Score new stories" hint="1–2 Gemini requests; your lineup isn't touched" />
        </div>
      )}
      <div className="filters">
        <Link href="/admin?tab=pool" className={!filterTopic ? "active" : ""}>All</Link>
        {TOPIC_KEYS.filter((k) => k !== "other").map((k) => (
          <Link key={k} href={`/admin?tab=pool&topic=${k}`} className={filterTopic === k ? "active" : ""}>{TOPICS[k]}</Link>
        ))}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Score</th><th>Story</th><th>Topic</th><th>Outlets</th><th></th></tr></thead>
          <tbody>
            {stories.map((s) => (
              <tr key={s.id}>
                <td className="num"><span className={`score-sq${s.score == null ? "" : Number(s.score) >= 85 ? " hi" : Number(s.score) >= 78 ? " mid" : ""}`}>{s.score == null ? "—" : Math.round(Number(s.score))}</span></td>
                <td>
                  <a href={s.url} target="_blank" rel="noreferrer">{s.headline}</a>
                  {s.editor_flag === "pin" && <span className="chip good">📌 Pinned</span>}
                  {s.editor_flag === "block" && <span className="chip warn">🚫 Blocked</span>}
                  {s.added && <span className="chip">Added by you</span>}
                  {s.reason && <div className="muted small">{s.reason}</div>}
                </td>
                <td>{s.topic ? <span className={topicChip(s.topic)}>{TOPICS[s.topic]}</span> : "—"}</td>
                <td className="nowrap muted small">{s.outlets} outlet{s.outlets === 1 ? "" : "s"}</td>
                <td className="nowrap">
                  {preDraft ? (
                    <div className="row-actions">
                      {s.editor_flag === "pin" ? (
                        <ActionButton op="unflag" fields={{ story: s.id }} label="Unpin" variant="ghost" />
                      ) : (
                        <ActionButton op="pin" fields={{ story: s.id }} label="📌 Pin" title="Must be in Wednesday's draft" />
                      )}
                      {s.editor_flag === "block" ? (
                        <ActionButton op="unflag" fields={{ story: s.id }} label="Unblock" variant="ghost" />
                      ) : (
                        <ActionButton op="block" fields={{ story: s.id }} label="🚫" variant="ghost" title="Keep it out of this week's issue" />
                      )}
                    </div>
                  ) : s.in_issue ? (
                    <span className={`chip${s.in_issue.startsWith("selected") ? " good" : ""}`}>{s.in_issue.startsWith("selected") ? "In lineup" : "On bench"}</span>
                  ) : editable ? (
                    <ActionButton op="add-to-bench" fields={{ issue: issue!.id, story: s.id }} label="Add to bench" />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ================================================================ Subscribers

async function SubscribersTab({ status }: { status?: string }) {
  const filter = ["active", "unsubscribed", "bounced"].includes(status ?? "") ? status! : null;
  const [counts] = await query<{ active: number; unsubscribed: number; bounced: number }>(
    `select count(*) filter (where status = 'active')::int as active, count(*) filter (where status = 'unsubscribed')::int as unsubscribed,
            count(*) filter (where status = 'bounced')::int as bounced from subscribers`,
  );
  const rows = await query<{ id: number; email: string; name: string | null; status: string; bounce_count: number; last_bounce_reason: string | null; subscribed_at: string; unsubscribed_at: string | null }>(
    `select id, email, name, status, bounce_count, last_bounce_reason, subscribed_at, unsubscribed_at from subscribers
     where ($1::text is null or status = $1) order by subscribed_at desc limit 200`,
    [filter],
  );
  return (
    <section>
      <h2 className="page-title">Subscribers</h2>
      <div className="stats">
        <Link href="/admin?tab=subscribers&status=active" className={`stat tone-green${filter === "active" ? " active" : ""}`}><b>{counts.active}</b><span className="muted">active</span></Link>
        <Link href="/admin?tab=subscribers&status=unsubscribed" className={`stat tone-neutral${filter === "unsubscribed" ? " active" : ""}`}><b>{counts.unsubscribed}</b><span className="muted">unsubscribed</span></Link>
        <Link href="/admin?tab=subscribers&status=bounced" className={`stat tone-rose${filter === "bounced" ? " active" : ""}`}><b>{counts.bounced}</b><span className="muted">bounced (suppressed)</span></Link>
      </div>
      <p className="muted small">
        Unsubscribes come from the email footer, Gmail&apos;s one-click button, or a reply with “unsubscribe”. Hard bounces are suppressed at once; soft
        bounces after 3 strikes.
      </p>
      <div className="panel">
      <AddSubscriberForm />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Email</th><th>Status</th><th>Bounces</th><th>Joined</th><th></th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.email}{s.name && <div className="muted small">{s.name}</div>}</td>
                <td><span className={`chip${s.status === "active" ? " good" : s.status === "bounced" ? " bad" : ""}`}>{s.status}</span>{s.last_bounce_reason && <div className="muted small">{s.last_bounce_reason}</div>}</td>
                <td>{s.bounce_count}</td>
                <td className="nowrap">{fmt(s.subscribed_at)}</td>
                <td>
                  {s.status === "active" ? <SubscriberButton id={s.id} op="unsubscribe" label="Unsubscribe" /> : <SubscriberButton id={s.id} op="reactivate" label="Reactivate" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="muted small">No subscribers{filter ? ` with status “${filter}”` : ""} yet.</p>}
      </div>
    </section>
  );
}

// ================================================================ Voice guide

async function GuideTab() {
  const edits = await editExamples();
  return (
    <>
    <section>
      <h2 className="page-title">Your voice guide</h2>
      <p className="muted small">
        Every AI draft and rewrite follows this guide, and the automatic checks (length, banned words, money format) come from it. Edit it like a
        document; changes apply to the next draft.
      </p>
      <div className="panel"><StyleGuideForm guide={await getStyleGuide()} /></div>
      <p className="small">
        The automatic checks on commentary and the scoring of stories are explained in <Link href="/admin?tab=scoring">How scoring works</Link>.
      </p>
    </section>
    <section>
      <h2>Learning from your edits</h2>
      <p className="muted small">
        Whenever you rewrite a commentary, the AI&apos;s version and yours are kept. Your {edits.length ? `last ${edits.length}` : "most recent"} real
        edits go to Gemini as before/after examples with every draft and rewrite, so the next drafts sound more like you. Small touch-ups (a word
        or two) are skipped.
      </p>
      {edits.length === 0 ? (
        <p className="muted">No edits yet. Edit a commentary on This week&apos;s issue (or reply to ✏️ Edit in Telegram) and it shows up here.</p>
      ) : (
        <div className="edits">
          {edits.map((e, i) => (
            <div key={i} className="card edit-pair">
              <p className="small"><b>{e.headline}</b></p>
              <div className="pair">
                <div><span className="eyebrow">AI draft</span><p className="before">{e.before}</p></div>
                <div><span className="eyebrow">Your version</span><p>{e.after}</p></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
    </>
  );
}

// ================================================================ Reader replies

async function RepliesTab({ view }: { view?: string }) {
  const archived = view === "archived";
  const rows = await query<{
    id: number; from_email: string; from_name: string | null; subject: string | null; body: string; received_at: string; status: string;
    issue_number: number | null; subscriber_status: string | null;
  }>(
    `select r.id, r.from_email, r.from_name, r.subject, r.body, r.received_at, r.status, i.issue_number, s.status as subscriber_status
     from reader_replies r left join issues i on i.id = r.issue_id left join subscribers s on s.id = r.subscriber_id
     where (r.status = 'archived') = $1 order by (r.status = 'new') desc, r.received_at desc limit 200`,
    [archived],
  );
  const [counts] = await query<{ unread: number; total: number; archived: number; people: number }>(
    `select count(*) filter (where status = 'new')::int as unread, count(*) filter (where status <> 'archived')::int as total,
            count(*) filter (where status = 'archived')::int as archived, count(distinct from_email)::int as people from reader_replies`,
  );
  const reSubject = (subject: string | null) => (subject && /^re:/i.test(subject) ? subject : `Re: ${subject ?? "The Dispatch"}`);
  return (
    <section>
      <div className="section-head">
        <h2 className="page-title">Reader replies</h2>
        <span className="row">
          {counts.unread > 0 && !archived && <ReplyButton id={0} op="read" label="Mark all read" />}
          <JobButton job="bounces" label="Check the inbox now" hint="Also processes bounces and unsubscribes" compact />
        </span>
      </div>
      <p className="muted small">
        Every newsletter ends with “just hit reply”. Those replies, and new emails from subscribers (tips, corrections), land here; bounces,
        unsubscribes, auto-replies and robots are filtered out. The quoted newsletter is trimmed so you only see their words. The inbox is checked at
        noon and 8 PM IST, and new replies are announced in Telegram.
      </p>
      <div className="stats">
        <Link href="/admin?tab=replies" className="stat tone-rose"><b>{counts.unread}</b><span className="muted">unread</span></Link>
        <Link href="/admin?tab=replies" className={`stat tone-blue${archived ? "" : " active"}`}><b>{counts.total}</b><span className="muted">in inbox</span></Link>
        <Link href="/admin?tab=replies&view=archived" className={`stat tone-neutral${archived ? " active" : ""}`}><b>{counts.archived}</b><span className="muted">archived</span></Link>
        <div className="stat tone-lav"><b>{counts.people}</b><span className="muted">readers wrote in</span></div>
      </div>
      {archived && <p className="small"><Link href="/admin?tab=replies">← Back to the inbox</Link></p>}
      {rows.length === 0 ? (
        <p className="muted">{archived ? "Nothing archived." : "No replies yet. They'll appear here after the first issue goes out."}</p>
      ) : (
        <div className="replies">
          {rows.map((r) => (
            <article key={r.id} className={`card reply${r.status === "new" ? " unread" : ""}`}>
              <header className="reply-head">
                <div>
                  <b>{r.from_name || r.from_email}</b>
                  {r.from_name && <span className="muted small"> · {r.from_email}</span>}
                  <div className="muted small">
                    {fmt(r.received_at)}
                    {r.issue_number != null && <> · replying to #{r.issue_number}</>}
                  </div>
                </div>
                <div className="reply-chips">
                  {r.status === "new" && <span className="chip dark">New</span>}
                  {r.subscriber_status ? (
                    <span className={`chip${r.subscriber_status === "active" ? "" : " warn"}`}>{r.subscriber_status === "active" ? "Subscriber" : `Subscriber · ${r.subscriber_status}`}</span>
                  ) : (
                    <span className="chip">Not a subscriber</span>
                  )}
                </div>
              </header>
              {r.subject && <p className="reply-subject">{r.subject}</p>}
              <p className="reply-body">{r.body}</p>
              <div className="card-actions">
                <a className="btn primary" href={`mailto:${r.from_email}?subject=${encodeURIComponent(reSubject(r.subject))}`}>Reply</a>
                {r.status === "new" && <ReplyButton id={r.id} op="read" label="Mark read" />}
                {r.status === "read" && <ReplyButton id={r.id} op="unread" label="Mark unread" />}
                {r.status === "archived" ? <ReplyButton id={r.id} op="unarchive" label="Move to inbox" /> : <ReplyButton id={r.id} op="archive" label="Archive" />}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

// ================================================================ How scoring works

async function ScoringTab({ issue }: { issue: EditorIssue | undefined }) {
  const week = weekStart();
  const [dist] = await query<{ total: number; avg: number | null; max: number | null; b80: number; b60: number; b40: number; b0: number }>(
    `select count(*)::int as total, round(avg(score))::int as avg, round(max(score))::int as max,
            count(*) filter (where score >= 80)::int as b80, count(*) filter (where score >= 60 and score < 80)::int as b60,
            count(*) filter (where score >= 40 and score < 60)::int as b40, count(*) filter (where score < 40)::int as b0
     from stories where week_start = $1 and score is not null`,
    [week],
  );
  const lead = issue ? (await loadEditorItems(issue.id)).filter((i) => isLive(i) && i.criteria).sort((a, b) => a.position - b.position)[0] : undefined;
  const keys = Object.keys(CRITERIA) as Criterion[];
  const bands = [
    { label: "80–100 · front-page material", n: dist.b80 },
    { label: "60–79 · strong", n: dist.b60 },
    { label: "40–59 · ordinary news", n: dist.b40 },
    { label: "0–39 · routine or noise", n: dist.b0 },
  ];
  const maxBand = Math.max(1, ...bands.map((b) => b.n));

  return (
    <div className="explainer">
      <section className="panel hero-card">
        <span className="chip">How scoring works</span>
        <p className="statement">
          Every story gets a score out of 100.{" "}
          <span className="faint">It measures how well it fits The Dispatch: counterintuitive, under-reported, or connecting two trends.</span>{" "}
          <span className="good-ink">You make the final call.</span>
        </p>
        <ol className="flow">
          <li>
            <b>Gemini reads the week.</b> Stories go to Gemini Flash in batches of 70, together with the headline of every other story this week, so it
            can spot connections between them.
          </li>
          <li>
            <b>Five criteria are scored 0–5 by Gemini; one is counted by code.</b> Gemini also writes the one-line &quot;why it was picked&quot; you see on
            each story. Under-reported is not a judgement call: the code counts how many different outlets ran the story.
          </li>
          <li>
            <b>Scores become points.</b> Each criterion has a weight. Its points are <code>weight × score ÷ 5</code>, so a 5/5 on Signal is worth 30
            points and a 3/5 is worth 18. The six add up to a total out of 100.
          </li>
          <li>
            <b>Adjustments.</b> −{SCORING.weakSourcingPenalty} points if every article in the story comes from a little-known outlet. Stories already covered in
            the last {SELECTION.lookbackIssues} issues are excluded entirely.
          </li>
          <li>
            <b>Gemini is told to be a demanding editor:</b> most stories should land at 1–3 on each criterion, and 5 is for the exceptional. That keeps
            the top of the list meaningful.
          </li>
        </ol>
      </section>

      <section>
        <h2>The six criteria</h2>
        <div className="criteria">
          {keys.map((k, i) => {
            const c = CRITERIA[k];
            return (
              <article key={k} className={`criterion tone-${["green", "blue", "lav", "butter", "rose", "sand"][i % 6]}`}>
                <div className="criterion-head">
                  <h3>{c.label}</h3>
                  <span className="weight">{Math.round(c.weight * 100)}% · up to {Math.round(c.weight * 100)} pts</span>
                </div>
                <p className="question">{c.question}</p>
                <p className="muted small">{c.why}</p>
                <ul className="scale">
                  {([0, 3, 5] as const).map((n) => (
                    <li key={n}><span className="score-dot">{n}</span>{c.anchors[n]}</li>
                  ))}
                </ul>
                <p className="scored-by">1, 2 and 4 sit in between. Scored by {c.scoredBy}.</p>
                {k === "under_reported" && (
                  <table className="mini">
                    <thead><tr><th>Outlets</th>{UNDER_REPORTED_SCALE.map((r) => <th key={r.outlets}>{r.outlets}</th>)}</tr></thead>
                    <tbody><tr><td>Score</td>{UNDER_REPORTED_SCALE.map((r) => <td key={r.outlets}>{r.score}</td>)}</tr></tbody>
                  </table>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <RubricEditSection />

      {lead?.criteria && (
        <section className="panel">
          <h2>Worked example: this week&apos;s lead story</h2>
          <p><b>{lead.headline}</b> <span className="muted small">· via {lead.publisher} · {new Set(lead.publishers).size} outlet(s)</span></p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Criterion</th><th>Score</th><th>Weight</th><th>Points</th></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k}>
                    <td>{CRITERIA[k].label}</td>
                    <td className="num">{lead.criteria![k]}/5</td>
                    <td className="num">{Math.round(CRITERIA[k].weight * 100)}%</td>
                    <td className="num">{Math.round(CRITERIA[k].weight * 100)} × {lead.criteria![k]} ÷ 5 = <b>{criterionPoints(k, lead.criteria![k])}</b></td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3}><b>Total</b> (before any weak-sourcing penalty)</td>
                  <td className="num"><b>{Math.round(keys.reduce((n, k) => n + criterionPoints(k, lead.criteria![k]), 0))}</b> / 100 · stored score {Math.round(Number(lead.score ?? 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted small">Gemini&apos;s reason: “{lead.reason}”</p>
        </section>
      )}

      {dist.total > 0 && (
        <section className="panel">
          <h2>This week&apos;s spread</h2>
          <p className="muted small">{dist.total} scored stories · average {dist.avg} · highest {dist.max}. Only the best few clear 80.</p>
          <div className="dist">
            {bands.map((b) => (
              <div key={b.label} className="bar-row">
                <span>{b.label}</span>
                <span className="bar"><span style={{ width: `${(b.n / maxBand) * 100}%` }} /></span>
                <span className="num">{b.n}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <h2>From scores to a lineup</h2>
        <ol className="flow">
          <li>The top {SELECTION.shortlist} stories by score form the shortlist.</li>
          <li>
            Gemini, acting as editor, picks {SELECTION.min}–{SELECTION.max} of them (aiming for {SELECTION.target}) and puts them in running order. It weighs
            the scores but also variety and connections between stories, and avoids an issue that is all funding rounds.
          </li>
          <li>
            Code then checks the hard rules: {SELECTION.min}–{SELECTION.max} stories, at least {SELECTION.minTopics} topics, at most {SELECTION.maxPerTopic} per
            topic, at most {SELECTION.maxPerCompany} per company, nothing from the last {SELECTION.lookbackIssues} issues. If a rule is broken, Gemini is told
            exactly which one and tries again (up to {SELECTION.repairAttempts} times); after that, code picks by score while enforcing the rules.
          </li>
          <li>The next {SELECTION.bench} best stories become the bench, your swap options.</li>
        </ol>
      </section>

      <section>
        <h2>How commentary is checked</h2>
        <div className="two-col">
          <div className="panel">
            <h3>Automatic checks (pass / fail)</h3>
            <ul className="tight">
              <li>{COMMENTARY.minSentences}–{COMMENTARY.maxSentences} sentences, {COMMENTARY.minWords}–{COMMENTARY.maxWords} words</li>
              <li>The first sentence doesn&apos;t just reword the headline</li>
              <li>No banned words from your voice guide (game-changer, delve, landscape, leverage…)</li>
              <li>No emojis, exclamation marks or hashtags</li>
              <li>Money written as ₹ Cr / $ Mn / $ Bn</li>
            </ul>
            <p className="muted small">These run live as you type in the editor.</p>
          </div>
          <div className="panel">
            <h3>AI copy-editor review (1–5 each)</h3>
            <ul className="tight">
              <li><b>Angle:</b> says something non-obvious, more than a summary</li>
              <li><b>Voice:</b> sounds like your voice guide</li>
              <li><b>Grounded:</b> every fact is in the source articles</li>
              <li><b>Forwardable:</b> would a founder forward it to their co-founder?</li>
            </ul>
            <p className="muted small">
              The average must be at least {COMMENTARY.minReviewAverage}. Anything that fails is rewritten once; if it still fails it&apos;s flagged ⚠ for you.
              Your own edits are never blocked.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

async function RubricEditSection() {
  const unlocked = await isRubricUnlocked();
  const configured = !!process.env.RUBRIC_PASSWORD;
  if (!unlocked) {
    return (
      <section className="panel rubric-lock">
        <h3>🔒 Edit the scoring rubric</h3>
        <p className="muted small">
          Weights, criterion wording, the penalty, lineup rules and commentary limits can be changed here. Editing needs the separate rubric
          password, so the scoring can&apos;t be changed by accident from a logged-in browser.
        </p>
        {configured ? <RubricUnlockForm minutes={RUBRIC_UNLOCK_MINUTES_LABEL} sampleHint={samplePasswords()?.rubric} /> : <p className="warn small">Set RUBRIC_PASSWORD to enable editing.</p>}
      </section>
    );
  }
  const history = await rubricHistory();
  return (
    <section className="panel rubric-open">
      <div className="section-head">
        <h3>🔓 Editing the scoring rubric</h3>
        <span className="row">
          <RestoreDefaultsButton />
          <form action={lockRubric}><button className="btn secondary">Lock</button></form>
        </span>
      </div>
      <p className="muted small">
        Saving re-ranks this week&apos;s stories with the new weights immediately (no AI calls) and updates the scores in Telegram. The current
        lineup isn&apos;t changed; use “Start over with a fresh draft” if you want a new selection under the new rules.
      </p>
      <RubricEditor
        rubric={snapshotRubric()}
        meta={CRITERION_KEYS.map((k) => ({ key: k, label: CRITERIA[k].label, scoredBy: CRITERIA[k].scoredBy }))}
      />
      <h3>History</h3>
      {history.length ? (
        <ul className="tight">
          {history.map((h) => (
            <li key={h.id}>
              {fmt(h.created_at)} · {h.note ?? "no note"}{" "}
              <span className="muted small">
                ({CRITERION_KEYS.map((k) => `${CRITERIA[k].label} ${Math.round(h.rubric.criteria[k].weight * 100)}%`).join(", ")})
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No changes yet: the built-in default rubric is in use.</p>
      )}
    </section>
  );
}

// ================================================================ Past issues

async function HistoryTab() {
  const issues = await query<{ id: number; issue_number: number; week_start: string; status: string; subject: string | null; sent_at: string | null; sent: number; bounced: number; failed: number }>(
    `select i.id, i.issue_number, i.week_start::text, i.status, i.subject, i.sent_at,
            count(d.id) filter (where d.status = 'sent')::int as sent, count(d.id) filter (where d.status = 'bounced')::int as bounced,
            count(d.id) filter (where d.status = 'failed')::int as failed
     from issues i left join deliveries d on d.issue_id = i.id group by i.id order by i.week_start desc limit 30`,
  );
  return (
    <section>
      <h2 className="page-title">Past issues</h2>
      <p className="muted small">Stories from the last four sent issues are automatically kept out of new drafts.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Issue</th><th>Status</th><th>Sent</th><th>Delivered</th><th>Bounced</th><th>Failed</th></tr></thead>
          <tbody>
            {issues.map((i) => (
              <tr key={i.id}>
                <td>
                  {i.status === "sent" ? <a href={`/issues/${i.id}`} target="_blank">{i.subject}</a> : (i.subject ?? `Issue #${i.issue_number}`)}
                  <div className="muted small">Week of {i.week_start}</div>
                </td>
                <td><span className={`chip${i.status === "sent" ? " good" : i.status === "failed" ? " bad" : ""}`}>{STATUS_COPY[i.status]?.label ?? i.status}</span></td>
                <td className="nowrap">{fmt(i.sent_at)}</td>
                <td>{i.sent}</td>
                <td>{i.bounced}</td>
                <td>{i.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ================================================================ Pipeline

async function PipelineTab() {
  const week = weekStart();
  const issue = await latestIssue();
  const [p] = await query<{ articles: number; relevant: number; stories: number; scored: number }>(
    `select (select count(*)::int from articles where week_start = $1) as articles,
            (select count(*)::int from articles where week_start = $1 and is_relevant) as relevant,
            (select count(*)::int from stories where week_start = $1) as stories,
            (select count(*)::int from stories where week_start = $1 and scored_at is not null) as scored`,
    [week],
  );
  const sources = await query<{ id: number; name: string; kind: string; active: boolean; last_fetched_at: string | null; last_item_count: number | null; last_error: string | null }>(
    "select id, name, kind, active, last_fetched_at, last_item_count, last_error from sources order by id",
  );
  const events = await query<{ kind: string; payload: Record<string, unknown>; created_at: string }>(
    "select kind, payload, created_at from events order by created_at desc limit 30",
  );
  return (
    <>
      <section>
        <h2 className="page-title">This week&apos;s pipeline · {week}</h2>
        <div className="stats">
          <div className="stat"><b>{p.articles}</b><span className="muted">articles read</span></div>
          <div className="stat"><b>{p.relevant}</b><span className="muted">relevant</span></div>
          <div className="stat"><b>{p.stories}</b><span className="muted">distinct stories</span></div>
          <div className="stat"><b>{p.scored}</b><span className="muted">scored</span></div>
        </div>
      </section>
      <section className="panel">
        <h2>Run a step now</h2>
        <p className="muted small">
          On schedule: fetch Mon–Wed 6 AM · early look Mon &amp; Tue 7 PM · draft Wed 2 PM · Telegram Wed 6 PM · reminder Wed 10 PM · send Thu 8 AM (IST). Emailing subscribers only
          ever happens after you confirm.
        </p>
        <div className="jobs">
          <JobButton job="ingest" label="Fetch new articles" hint="All sources, then screen and dedupe" />
          <JobButton job="draft" label="Draft this week's issue" hint="Score, select, write commentary" />
          <JobButton job="deliver" label="Post draft to Telegram" hint="Only if a draft is ready" />
          <JobButton job="remind" label="Send Telegram reminder" hint="Only if the issue isn't confirmed yet; sent once" />
          <JobButton job="early-look" label="Post the early look" hint="Fetch, score and post today's top 5 to Telegram for pin / block (before the draft only)" />
          <JobButton job="bounces" label="Check the inbox" hint="Reader replies, bounces and unsubscribes" />
          <JobButton job="score" label="Score new stories" hint="Rank stories that arrived after the draft; the lineup isn't touched" />
        </div>
        {issue && EDITABLE.includes(issue.status) && (
          <div className="reanalyse">
            <p><b>Re-analyse from scratch.</b> Re-score every story this week and draft #{issue.issue_number} again. Use this if a lot of news broke after the draft.</p>
            <RedraftPanel issueId={issue.id} edits={(await loadEditorItems(issue.id)).filter((i) => i.edited_by_shreya).length} />
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Sources</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Type</th><th>Last fetch</th><th>Items</th><th></th></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className={s.active ? "" : "dim"}>
                  <td>{s.name}{s.last_error && <div className="error small">{s.last_error}</div>}</td>
                  <td><span className={`chip tone-${s.kind === "rss" ? "sand" : "blue"}`}>{s.kind === "rss" ? "RSS" : "Google News"}</span></td>
                  <td className="nowrap">{fmt(s.last_fetched_at)}</td>
                  <td>{s.last_item_count ?? "—"}</td>
                  <td>
                    <form action={toggleSource}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="btn secondary small-btn">{s.active ? "Pause" : "Resume"}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Activity</h2>
        <div className="table-wrap">
          <table>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}><td className="nowrap">{fmt(e.created_at)}</td><td>{e.kind.replace(/_/g, " ")}</td><td className="muted small">{JSON.stringify(e.payload).slice(0, 140)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
