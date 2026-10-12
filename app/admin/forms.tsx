"use client";

import Link, { useLinkStatus } from "next/link";
import { useActionState, useLayoutEffect, useRef, useState } from "react";
import { checkCommentary, type CommentaryLimits, CRITERION_KEYS, type Rubric } from "@/lib/rubric";
import {
  type ActionState,
  editorAction,
  replyAction,
  restoreDefaultRubric,
  runJob,
  saveRubricAction,
  subscriberAction,
  unlockRubric,
  updateStyleGuide,
} from "./actions";

function Result({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <p className={`result ${state.ok ? "ok" : "error"}`} role="status">
      {state.message}
    </p>
  );
}

type Fields = Record<string, string | number>;

function Hidden({ fields }: { fields: Fields }) {
  return (
    <>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

/** A single editor operation as a button (approve, drop, move…). */
export function ActionButton({
  op,
  fields,
  label,
  pendingLabel,
  variant = "secondary",
  title,
}: {
  op: string;
  fields: Fields;
  label: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "good";
  title?: string;
}) {
  const [state, action, pending] = useActionState(editorAction, null);
  return (
    <form action={action} className="action">
      <Hidden fields={{ ...fields, op }} />
      <button className={`btn ${variant}`} disabled={pending} title={title}>
        {pending ? (pendingLabel ?? "…") : label}
      </button>
      {state && !state.ok && <Result state={state} />}
    </form>
  );
}

/** Inline commentary editing with the rubric's checks running as she types. */
export function CommentaryEditor({
  itemId,
  issueId,
  headline,
  initial,
  original,
  locked,
  limits,
  approves = true,
}: {
  itemId: number;
  issueId: number;
  headline: string;
  initial: string;
  original: string | null;
  locked: boolean;
  /** The server's live commentary limits (they're editable in the scoring rubric). */
  limits: CommentaryLimits;
  /** Lineup stories are approved when Shreya saves her edit; bench stories just save. */
  approves?: boolean;
}) {
  const [text, setText] = useState(initial);
  const [saveState, save, saving] = useActionState(editorAction, null);
  const [aiState, rewrite, rewriting] = useActionState(editorAction, null);
  const [showAi, setShowAi] = useState(false);
  const checks = checkCommentary(text, headline, limits);
  const dirty = text.trim() !== initial.trim();

  // A Gemini rewrite changes the saved text; pick it up when the server re-renders.
  const [lastInitial, setLastInitial] = useState(initial);
  if (initial !== lastInitial) {
    setLastInitial(initial);
    setText(initial);
  }

  return (
    <div className="editor">
      <form action={save}>
        <Hidden fields={{ op: "commentary", item: itemId, issue: issueId }} />
        <textarea
          name="commentary"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={Math.max(4, Math.ceil(text.length / 80) + 1)}
          disabled={locked}
          aria-label="Commentary"
          className="commentary"
        />
        <div className="editor-bar">
          <span className={`meter ${checks.words < limits.minWords || checks.words > limits.maxWords ? "warn" : ""}`}>
            {checks.words} words · {checks.sentences} sentences
          </span>
          {checks.failures.length > 0 ? (
            <span className="warn small">⚠ {checks.failures.join(" · ")}</span>
          ) : (
            <span className="ok small">✓ passes the voice-guide checks</span>
          )}
          {!locked && (
            <span className="editor-actions">
              {dirty && (
                <button type="button" className="btn ghost" onClick={() => setText(initial)}>
                  Discard changes
                </button>
              )}
              {original && original !== text && (
                <button type="button" className="btn ghost" onClick={() => setText(original)} title="Restore the first AI draft">
                  Original draft
                </button>
              )}
              <button type="button" className="btn ghost" onClick={() => setShowAi((v) => !v)} aria-expanded={showAi}>
                Rewrite with Gemini
              </button>
              <button className="btn primary" disabled={!dirty || saving}>
                {saving ? "Saving…" : approves ? "Save & approve" : "Save"}
              </button>
            </span>
          )}
        </div>
        <Result state={saveState} />
      </form>
      {showAi && !locked && (
        <form action={rewrite} className="ai-form">
          <Hidden fields={{ op: "rewrite", item: itemId, issue: issueId }} />
          <input name="instruction" placeholder="Optional: e.g. punchier, lead with the number, connect it to quick commerce" />
          <button className="btn lav" disabled={rewriting}>{rewriting ? "Gemini is writing…" : "Rewrite"}</button>
          <Result state={aiState} />
        </form>
      )}
    </div>
  );
}

export type SwapOption = {
  id: number;
  headline: string;
  topic: string;
  score: number;
  outlets: number;
  /** Rubric breakdown: short label, 0–5 score and the points it contributes. */
  criteria: { label: string; name: string; score: number; points: number }[];
};

/** Bench stories with their rubric scores, best first; each can be swapped in for this story. */
export function SwapPicker({ itemId, issueId, currentScore, bench }: { itemId: number; issueId: number; currentScore: number; bench: SwapOption[] }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(editorAction, null);
  if (!bench.length) return <span className="muted small">No bench stories with commentary.</span>;
  return (
    <div className={`swap${open ? " open" : ""}`}>
      <button type="button" className="btn secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "Close swap options" : <>Swap… <span className="swap-count">{bench.length} on the bench</span></>}
      </button>
      {open && (
        <div className="swap-panel">
          <p className="muted small">
            Bench stories ranked by rubric score. This story scores <b>{currentScore}</b>. Hover a score to see what it means.
          </p>
          <ul>
            {bench.map((b) => {
              const diff = b.score - currentScore;
              return (
                <li key={b.id}>
                  <div className="swap-score" title="Total rubric score out of 100">
                    <b>{b.score}</b>
                    <span className={diff >= 0 ? "ok" : "muted"}>{diff >= 0 ? `+${diff}` : diff}</span>
                  </div>
                  <div className="swap-body">
                    <div className="swap-title" title={`${b.topic} · ${b.headline}`}>{b.headline}</div>
                    <div className="swap-criteria">
                      {b.criteria.map((c) => (
                        <span key={c.label} className={`crit s${c.score}`} title={`${c.name}: ${c.score}/5 → ${c.points} pts`}>
                          {c.label} <b>{c.score}</b>
                        </span>
                      ))}
                      <span className="muted small">· {b.outlets} outlet{b.outlets === 1 ? "" : "s"}</span>
                    </div>
                  </div>
                  <form action={action}>
                    <Hidden fields={{ op: "swap", item: itemId, issue: issueId, bench: b.id }} />
                    <button className="btn primary" disabled={pending}>{pending ? "…" : "Swap in"}</button>
                  </form>
                </li>
              );
            })}
          </ul>
          <Result state={state} />
        </div>
      )}
      {!open && state && !state.ok && <Result state={state} />}
    </div>
  );
}

export function IssueTextForm({ issueId, subject, intro, locked }: { issueId: number; subject: string; intro: string; locked: boolean }) {
  const [state, action, pending] = useActionState(editorAction, null);
  return (
    <form action={action} className="stack">
      <Hidden fields={{ op: "issue-text", issue: issueId }} />
      <label>
        Subject line
        <input name="subject" defaultValue={subject} disabled={locked} maxLength={200} />
      </label>
      <label>
        Opening (2–3 sentences)
        <textarea name="intro" defaultValue={intro} rows={3} disabled={locked} className="commentary" />
      </label>
      {!locked && (
        <div>
          <button className="btn primary" disabled={pending}>{pending ? "Saving…" : "Save subject & opening"}</button>
        </div>
      )}
      <Result state={state} />
    </form>
  );
}

/** Two-step confirmation: the only control that makes an issue sendable. */
export function ConfirmPanel({ issueId, ready, summary }: { issueId: number; ready: boolean; summary: string }) {
  const [armed, setArmed] = useState(false);
  const [state, action, pending] = useActionState(editorAction, null);
  if (!armed) {
    return (
      <div className="confirm">
        <button className="btn primary big" disabled={!ready} onClick={() => setArmed(true)}>
          Confirm final draft
        </button>
        {!ready && <span className="muted small">Finish the checklist above first.</span>}
        <Result state={state} />
      </div>
    );
  }
  return (
    <form action={action} className="confirm armed">
      <Hidden fields={{ op: "confirm", issue: issueId }} />
      <p><b>Send this issue?</b> {summary} You can still reopen it before then.</p>
      <div className="row">
        <button className="btn primary big" disabled={pending}>{pending ? "Confirming…" : "Yes, confirm and schedule"}</button>
        <button type="button" className="btn ghost" onClick={() => setArmed(false)}>Cancel</button>
      </div>
      <Result state={state} />
    </form>
  );
}

export function JobButton({ job, label, hint, compact = false }: { job: string; label: string; hint: string; compact?: boolean }) {
  const [state, action, pending] = useActionState(runJob, null);
  return (
    <form action={action} className={compact ? "job compact" : "job"}>
      <input type="hidden" name="job" value={job} />
      {!compact && <span className="muted small job-hint">{hint}</span>}
      <button className={`btn ${compact ? "primary" : "secondary"}`} disabled={pending} title={compact ? hint : undefined}>{pending ? "Starting…" : label}</button>
      <Result state={state} />
    </form>
  );
}

export function StyleGuideForm({ guide }: { guide: string }) {
  const [state, action, pending] = useActionState(updateStyleGuide, null);
  return (
    <form action={action} className="stack">
      <textarea name="guide" defaultValue={guide} rows={24} spellCheck className="mono" />
      <div>
        <button className="btn primary" disabled={pending}>{pending ? "Saving…" : "Save voice guide"}</button>
      </div>
      <Result state={state} />
    </form>
  );
}

export function AddSubscriberForm() {
  const [state, action, pending] = useActionState(subscriberAction, null);
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="op" value="add" />
      <input type="email" name="email" placeholder="email@example.com" required aria-label="Email" />
      <input type="text" name="name" placeholder="Name (optional)" aria-label="Name" />
      <button className="btn primary" disabled={pending}>Add subscriber</button>
      <Result state={state} />
    </form>
  );
}

export function SubscriberButton({ id, op, label }: { id: number; op: "unsubscribe" | "reactivate"; label: string }) {
  const [state, action, pending] = useActionState(subscriberAction, null);
  return (
    <form action={action} className="action">
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="id" value={id} />
      <button className="link-btn" disabled={pending}>{label}</button>
      {state && !state.ok && <Result state={state} />}
    </form>
  );
}

/** Two-step "start over": clears the lineup and commentary, then re-runs the whole editorial pass. */
export function RedraftPanel({ issueId, edits }: { issueId: number; edits: number }) {
  const [armed, setArmed] = useState(false);
  const [state, action, pending] = useActionState(editorAction, null);
  if (state?.ok) return <Result state={state} />;
  if (!armed) {
    return (
      <div className="stack">
        <button className="btn danger" onClick={() => setArmed(true)}>Start over with a fresh draft</button>
        <Result state={state} />
      </div>
    );
  }
  return (
    <form action={action} className="confirm armed">
      <input type="hidden" name="op" value="redraft" />
      <input type="hidden" name="issue" value={issueId} />
      <p>
        <b>Throw away this draft?</b> The lineup, bench, subject, opening and all commentary are replaced
        {edits ? `, including your ${edits} edit${edits === 1 ? "" : "s"}` : ""}. The engine re-scores every story this week and writes a new
        draft (about 10 Gemini requests, a few minutes). If it was already in Telegram, the new one is posted there too.
      </p>
      <div className="row">
        <button className="btn danger" disabled={pending}>{pending ? "Starting…" : "Yes, start over"}</button>
        <button type="button" className="btn ghost" onClick={() => setArmed(false)}>Keep this draft</button>
      </div>
      <Result state={state} />
    </form>
  );
}

// ---------------------------------------------------------------- scoring rubric editor

export function RubricUnlockForm({ minutes, sampleHint }: { minutes: string; sampleHint?: string }) {
  const [state, action, pending] = useActionState(unlockRubric, null);
  return (
    <>
      <form action={action} className="inline-form">
        <input type="password" name="password" placeholder="Rubric password" required autoComplete="off" aria-label="Rubric password" />
        <button className="btn primary" disabled={pending}>{pending ? "Checking…" : "Unlock to edit"}</button>
        <span className="muted small">Separate from the editor login. Stays unlocked for {minutes} on this browser.</span>
        {state && !state.ok && <Result state={state} />}
      </form>
      {sampleHint && (
        <p className="hint-bubble" role="note">
          This is a sample site, so the rubric password is shown: <code>{sampleHint}</code>
        </p>
      )}
    </>
  );
}

type CriterionMeta = { key: (typeof CRITERION_KEYS)[number]; label: string; scoredBy: string };

export function RubricEditor({ rubric, meta }: { rubric: Rubric; meta: CriterionMeta[] }) {
  const [state, action, pending] = useActionState(saveRubricAction, null);
  const [weights, setWeights] = useState<Record<string, number>>(() =>
    Object.fromEntries(meta.map((m) => [m.key, Math.round(rubric.criteria[m.key].weight * 100)])),
  );
  const total = Object.values(weights).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const sel = rubric.selection;
  const com = rubric.commentary;
  const num = (name: string, value: number, label: string, extra: { min?: number; max?: number; step?: number } = {}) => (
    <label className="num-field">
      <span>{label}</span>
      <input type="number" name={name} defaultValue={value} required {...extra} />
    </label>
  );

  return (
    <form action={action} className="rubric-editor">
      <section>
        <div className="section-head">
          <h3>Weights</h3>
          <span className={`sum ${total === 100 ? "ok" : "warn"}`}>Total {total}% {total === 100 ? "✓" : "· must be 100%"}</span>
        </div>
        <p className="muted small">How much each criterion counts. A story&apos;s points on a criterion are weight × score ÷ 5.</p>
        <div className="weights">
          {meta.map((m) => (
            <label key={m.key} className="weight-field">
              <span>{m.label}</span>
              <span className="row">
                <input
                  type="number"
                  name={`w_${m.key}`}
                  min={0}
                  max={100}
                  step={1}
                  value={weights[m.key]}
                  onChange={(e) => setWeights((w) => ({ ...w, [m.key]: Number(e.target.value) }))}
                  required
                />
                <span className="muted">%</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h3>What each criterion means</h3>
        <p className="muted small">
          This wording is sent to Gemini word for word when it scores stories, and shown in “How scoring works”. Changes apply the next time
          stories are scored.
        </p>
        {meta.map((m) => {
          const c = rubric.criteria[m.key];
          const fixed = m.scoredBy === "Code";
          return (
            <fieldset key={m.key} className="criterion-edit">
              <legend>{m.label} <span className="muted small">· {weights[m.key]}% · scored by {m.scoredBy}</span></legend>
              {fixed && <p className="muted small">Counted by code from the number of outlets, so its wording is descriptive only.</p>}
              <label>Question<input name={`q_${m.key}`} defaultValue={c.question} readOnly={fixed} maxLength={240} /></label>
              <label>Why it matters<input name={`why_${m.key}`} defaultValue={c.why} readOnly={fixed} maxLength={240} /></label>
              <div className="anchors">
                {([0, 3, 5] as const).map((n) => (
                  <label key={n}>A {n} looks like<input name={`a${n}_${m.key}`} defaultValue={c.anchors[n]} readOnly={fixed} maxLength={240} /></label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </section>

      <section>
        <h3>Penalty</h3>
        <div className="num-grid">{num("penalty", rubric.weakSourcingPenalty, "Weak-sourcing penalty (points)", { min: 0, max: 50 })}</div>
      </section>

      <section>
        <h3>Lineup rules</h3>
        <div className="num-grid">
          {num("sel_min", sel.min, "Min stories", { min: 1, max: 15 })}
          {num("sel_max", sel.max, "Max stories", { min: 1, max: 15 })}
          {num("sel_target", sel.target, "Target stories", { min: 1, max: 15 })}
          {num("sel_minTopics", sel.minTopics, "Min topics", { min: 1, max: 15 })}
          {num("sel_maxPerTopic", sel.maxPerTopic, "Max per topic", { min: 1, max: 15 })}
          {num("sel_maxPerCompany", sel.maxPerCompany, "Max per company", { min: 1, max: 15 })}
          {num("sel_shortlist", sel.shortlist, "Shortlist size", { min: 1, max: 60 })}
          {num("sel_bench", sel.bench, "Bench size", { min: 0, max: 20 })}
          {num("sel_lookbackIssues", sel.lookbackIssues, "No repeats from last N issues", { min: 0, max: 12 })}
        </div>
      </section>

      <section>
        <h3>Commentary limits</h3>
        <div className="num-grid">
          {num("com_minSentences", com.minSentences, "Min sentences", { min: 1, max: 8 })}
          {num("com_maxSentences", com.maxSentences, "Max sentences", { min: 1, max: 8 })}
          {num("com_minWords", com.minWords, "Min words", { min: 10, max: 200 })}
          {num("com_maxWords", com.maxWords, "Max words", { min: 10, max: 200 })}
          {num("com_minReviewAverage", com.minReviewAverage, "AI review bar (1–5)", { min: 1, max: 5, step: 0.25 })}
        </div>
      </section>

      <section className="save-row">
        <input name="note" placeholder="What changed and why (optional, shown in the history)" maxLength={200} />
        <button className="btn primary" disabled={pending || total !== 100}>{pending ? "Saving…" : "Save rubric"}</button>
      </section>
      <Result state={state} />
    </form>
  );
}

export function RestoreDefaultsButton() {
  const [state, action, pending] = useActionState(restoreDefaultRubric, null);
  const [armed, setArmed] = useState(false);
  if (!armed) return <button className="btn ghost" onClick={() => setArmed(true)}>Restore defaults…</button>;
  return (
    <form action={action} className="row">
      <button className="btn danger" disabled={pending}>{pending ? "Restoring…" : "Yes, restore the default rubric"}</button>
      <button type="button" className="btn ghost" onClick={() => setArmed(false)}>Cancel</button>
      <Result state={state} />
    </form>
  );
}

/** Paste a link to a story the feeds missed; it's deduped, scored and benched (or pinned before the draft). */
export function AddLinkForm({ hint }: { hint: string }) {
  const [state, action, pending] = useActionState(editorAction, null);
  return (
    <form action={action} className="add-link">
      <input type="hidden" name="op" value="add-link" />
      <div className="inline-form">
        <input type="url" name="url" placeholder="https://… a story the feeds missed" required aria-label="Story link" />
        <input type="text" name="headline" placeholder="Headline (if paywalled)" aria-label="Headline" />
        <button className="btn secondary" disabled={pending}>{pending ? "Reading, scoring, drafting…" : "Add story"}</button>
      </div>
      <p className="muted small">{hint}</p>
      <Result state={state} />
    </form>
  );
}

export function ReplyButton({ id, op, label }: { id: number; op: "read" | "unread" | "archive" | "unarchive"; label: string }) {
  const [state, action, pending] = useActionState(replyAction, null);
  return (
    <form action={action} className="action">
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="id" value={id} />
      <button className={`btn ${id === 0 ? "white" : "ghost"}`} disabled={pending}>{pending ? "…" : label}</button>
      {state && !state.ok && <Result state={state} />}
    </form>
  );
}

/** Rendered inside a tab link: marks it while its page loads, so the nav and content can react at once. */
export function TabPending() {
  const { pending } = useLinkStatus();
  return <span className="tab-pending" data-pending={pending ? "" : undefined} aria-hidden="true" />;
}

/** Two-step "re-rank": re-picks the lineup from this week's pool with the current rubric weights. */
export function RerankPanel({ issueId, summary }: { issueId: number; summary: string }) {
  const [armed, setArmed] = useState(false);
  const [state, action, pending] = useActionState(editorAction, null);
  if (state?.ok) return <Result state={state} />;
  if (!armed) {
    return (
      <div className="row">
        <button type="button" className="btn primary" onClick={() => setArmed(true)}>Re-rank the lineup</button>
        <Result state={state} />
      </div>
    );
  }
  return (
    <form action={action} className="confirm armed">
      <input type="hidden" name="op" value="rerank" />
      <input type="hidden" name="issue" value={issueId} />
      <p><b>Re-rank this week&apos;s lineup?</b> {summary}</p>
      <div className="row">
        <button className="btn primary" disabled={pending}>{pending ? "Re-ranking… (about a minute)" : "Yes, re-rank"}</button>
        <button type="button" className="btn ghost" onClick={() => setArmed(false)} disabled={pending}>Cancel</button>
      </div>
      <Result state={state} />
    </form>
  );
}

/** "Send a test email": one tap to the newsletter inbox, or type any one address. Never reaches subscribers. */
export function TestEmailPanel({
  issueId,
  inbox,
  providers,
  defaultProvider,
}: {
  issueId: number;
  inbox: string;
  /** Senders that are set up; with more than one, Shreya picks which sends the test. */
  providers: { key: "gmail" | "resend"; label: string; me: string; note?: string }[];
  defaultProvider: "gmail" | "resend";
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(editorAction, null);
  const [sentTo, setSentTo] = useState<"me" | "other" | null>(null);
  const [via, setVia] = useState(providers.some((p) => p.key === defaultProvider) ? defaultProvider : providers[0]?.key ?? "gmail");
  const chosen = providers.find((p) => p.key === via);
  const me = chosen?.me ?? inbox;
  return (
    <div className={`test-email${open ? " open" : ""}`}>
      <button type="button" className="btn secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "Close" : "Send a test email"}
      </button>
      {open && (
        <div className="test-email-panel">
          {providers.length > 1 && (
            <div className="test-via" role="radiogroup" aria-label="Send the test with">
              <span className="muted small">Send with</span>
              {providers.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  role="radio"
                  aria-checked={via === p.key}
                  className={`via-pill${via === p.key ? " on" : ""}`}
                  onClick={() => setVia(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
          {chosen?.note && <p className="test-note small">{chosen.note}</p>}
          <form action={action} onSubmit={() => setSentTo("me")} className="test-row">
            <Hidden fields={{ op: "test-email", issue: issueId, via }} />
            <button className="btn primary" disabled={pending}>{pending && sentTo === "me" ? "Sending…" : "Send to me"}</button>
            <span className="muted small">{me}</span>
          </form>
          <p className="test-or">or to someone else</p>
          <form action={action} onSubmit={() => setSentTo("other")} className="test-row">
            <Hidden fields={{ op: "test-email", issue: issueId, via }} />
            <input type="email" name="to" placeholder="name@example.com" required aria-label="Send the test to this email address" />
            <button className="btn primary" disabled={pending}>{pending && sentTo === "other" ? "Sending…" : "Send"}</button>
          </form>
          <p className="muted small">Marked [TEST] and sent only to that address. Subscribers and the issue aren&apos;t touched.</p>
          <Result state={state} />
        </div>
      )}
    </div>
  );
}

/**
 * The issue's progress track. A single "current" pill glides from step to step when the status changes
 * (e.g. on Confirm), the step left behind turns green and its ✓ fades in. Server-rendered first; the
 * pill takes over once it has measured the steps.
 */
export function ProgressSteps({ steps, current, allDone }: { steps: { key: string; label: string }[]; current: number; allDone: boolean }) {
  const ref = useRef<HTMLOListElement>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [animated, setAnimated] = useState(false);

  useLayoutEffect(() => {
    const ol = ref.current;
    if (!ol) return;
    const measure = () => {
      const li = ol.querySelectorAll("li")[Math.max(0, current)] as HTMLElement | undefined;
      if (li) setBox({ x: li.offsetLeft, y: li.offsetTop, w: li.offsetWidth, h: li.offsetHeight });
    };
    measure();
    // Only animate moves after the first placement, so the pill doesn't fly in on page load.
    const frame = requestAnimationFrame(() => setAnimated(true));
    const ro = new ResizeObserver(measure);
    ro.observe(ol);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [current]);

  return (
    <ol ref={ref} className={`steps progress${box ? " ready" : ""}${animated ? " animated" : ""}`} aria-label="Issue progress">
      <span
        className="step-indicator"
        aria-hidden="true"
        style={box ? { transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h, opacity: allDone ? 0 : 1 } : { opacity: 0 }}
      />
      {steps.map((step, i) => {
        const done = allDone || i < current;
        const now = !allDone && i === current;
        return (
          <li key={step.key} className={done ? "done" : now ? "current" : ""} aria-current={now ? "step" : undefined}>
            <span className="step-mark" aria-hidden="true">{done ? "✓" : "●"}</span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Topic filter pills with one dark highlight that glides to the pill you click. It moves at once
 * (before the filtered list arrives) and follows the server's choice once the page updates.
 */
export function FilterPills({ items, active }: { items: { key: string; label: string; href: string }[]; active: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(active);
  const [lastActive, setLastActive] = useState(active);
  if (active !== lastActive) {
    setLastActive(active);
    setSelected(active);
  }
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [animated, setAnimated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const pill = el.querySelector<HTMLElement>(`[data-key="${CSS.escape(selected)}"]`);
      if (pill) setBox({ x: pill.offsetLeft, y: pill.offsetTop, w: pill.offsetWidth, h: pill.offsetHeight });
    };
    measure();
    const frame = requestAnimationFrame(() => setAnimated(true));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [selected]);

  return (
    <div ref={ref} className={`filters sliding${box ? " ready" : ""}${animated ? " animated" : ""}`}>
      <span className="filter-indicator" aria-hidden="true" style={box ? { transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h } : { opacity: 0 }} />
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          data-key={it.key}
          className={it.key === selected ? "active" : ""}
          aria-current={it.key === active ? "page" : undefined}
          onClick={() => setSelected(it.key)}
          scroll={false}
        >
          {it.label}
        </Link>
      ))}
    </div>
  );
}
