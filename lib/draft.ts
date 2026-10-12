// Wednesday editorial pass: score every story (rubric A), select 8–10 (rubric B),
// draft commentary in Shreya's voice and quality-check it (rubric C).
// Every stage saves its work, so a run that hits the time limit simply resumes on the next call.
import { logEvent, query } from "./db";
import { generateJson } from "./gemini";
import {
  checkCommentary,
  COMMENTARY,
  CRITERIA,
  type CriterionScores,
  isRecognisedOutlet,
  SELECTION,
  underReportedScore,
  weightedScore,
} from "./rubric";
import { loadRubric } from "./rubric-store";
import { getStyleGuide } from "./style";
import { normalizePublisher, trigramSimilarity, truncate } from "./text";
import { type Topic, TOPIC_KEYS, TOPICS } from "./topics";
import { weekStart } from "./week";

const FIRST_ISSUE_NUMBER = Number(process.env.FIRST_ISSUE_NUMBER ?? 105);
const SCORE_BATCH = 70;

type GeminiScores = Omit<CriterionScores, "under_reported"> & {
  connects_to: number;
  topic: Topic;
  company: string;
  reason: string;
};

type Candidate = {
  id: number;
  headline: string;
  url: string;
  summary: string | null;
  variants: string[];
  publishers: string[];
  outlets: number;
  topic: Topic;
  company: string;
  gemini: GeminiScores | null;
  criteria: CriterionScores | null;
  score: number;
  weakSourcing: boolean;
  flag: "pin" | "block" | null;
};

type Issue = { id: number; week_start: string; status: string; issue_number: number };

// ---------------------------------------------------------------- data

async function loadCandidates(week: string): Promise<Candidate[]> {
  const rows = await query<{
    id: number;
    headline: string;
    scores: GeminiScores | null;
    article_topic: Topic | null;
    publishers: string[];
    variants: string[] | null;
    summary: string | null;
    url: string;
    editor_flag: "pin" | "block" | null;
  }>(
    `select s.id, s.headline, s.scores, s.editor_flag,
            mode() within group (order by a.topic) as article_topic,
            array_agg(distinct a.publisher) as publishers,
            (array_agg(distinct a.title) filter (where a.title <> s.headline))[1:3] as variants,
            (array_agg(a.summary order by length(a.summary) desc) filter (where length(a.summary) > 40))[1] as summary,
            (array_agg(a.url order by (a.url like 'https://news.google.com/%'), a.id))[1] as url
     from stories s join articles a on a.story_id = s.id
     where a.week_start = $1 and a.is_relevant
     group by s.id order by s.id`,
    [week],
  );

  return rows.map((r) => {
    const outlets = new Set(r.publishers.map(normalizePublisher)).size;
    const weakSourcing = !r.publishers.some(isRecognisedOutlet);
    const gemini = r.scores;
    const criteria = gemini
      ? {
          signal: gemini.signal,
          counterintuitive: gemini.counterintuitive,
          under_reported: underReportedScore(outlets),
          connects: gemini.connects,
          india: gemini.india,
          commentary_potential: gemini.commentary_potential,
        }
      : null;
    return {
      id: Number(r.id),
      headline: r.headline,
      url: r.url,
      summary: r.summary,
      variants: r.variants ?? [],
      publishers: r.publishers,
      outlets,
      topic: gemini?.topic ?? r.article_topic ?? "other",
      company: gemini?.company ?? "",
      gemini,
      criteria,
      score: criteria ? weightedScore(criteria, weakSourcing) : 0,
      weakSourcing,
      flag: r.editor_flag,
    };
  });
}

/** Stories used in the last 4 sent newsletters. */
export async function loadCovered(week: string): Promise<{ id: number; headline: string }[]> {
  const rows = await query<{ id: number; headline: string }>(
    `select s.id, s.headline
     from issue_items ii
     join stories s on s.id = ii.story_id
     where ii.role = 'selected' and ii.status <> 'dropped'
       and ii.issue_id in (select id from issues where status = 'sent' and week_start < $1 order by week_start desc limit $2)`,
    [week, SELECTION.lookbackIssues],
  );
  return rows.map((r) => ({ id: Number(r.id), headline: r.headline }));
}

async function ensureIssue(week: string): Promise<Issue> {
  const [existing] = await query<Issue>("select id, week_start::text, status, issue_number from issues where week_start = $1", [week]);
  if (existing) return existing;
  const [{ sent }] = await query<{ sent: number }>("select count(*)::int as sent from issues where status = 'sent'");
  const [created] = await query<Issue>(
    `insert into issues (week_start, issue_number) values ($1, $2)
     on conflict (week_start) do update set week_start = excluded.week_start
     returning id, week_start::text, status, issue_number`,
    [week, FIRST_ISSUE_NUMBER + sent],
  );
  return created;
}

// ---------------------------------------------------------------- A. scoring

// Built from the shared rubric so the prompt and the dashboard explainer can never disagree.
const geminiCriteria = () => (["signal", "counterintuitive", "connects", "india", "commentary_potential"] as const).map((k) => {
  const c = CRITERIA[k];
  const extra = k === "connects" ? "\n  (set connects_to to that story's id when connects >= 3, otherwise 0)" : "";
  return `- ${k}: ${c.question} 0 = ${c.anchors[0]}; 3 = ${c.anchors[3]}; 5 = ${c.anchors[5]}${extra}`;
});

const scoreSystem = () => `You are the editorial analyst for "The Dispatch", a weekly newsletter on the Indian startup ecosystem
read by founders, operators and investors. Score each story 0-5 on these criteria (integers):

${geminiCriteria().join("\n")}

Be a demanding editor: most stories should land at 1-3; reserve 5 for the exceptional.
Also return: topic (best fit), company (the main company or organisation, or "" if none), and
reason: one line, max 20 words, saying why this story matters (or doesn't) to the reader.`;

const SCORE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          signal: { type: "integer", minimum: 0, maximum: 5 },
          counterintuitive: { type: "integer", minimum: 0, maximum: 5 },
          connects: { type: "integer", minimum: 0, maximum: 5 },
          connects_to: { type: "integer", description: "id of the linked story, or 0 if none" },
          india: { type: "integer", minimum: 0, maximum: 5 },
          commentary_potential: { type: "integer", minimum: 0, maximum: 5 },
          topic: { type: "string", enum: TOPIC_KEYS },
          company: { type: "string" },
          reason: { type: "string" },
        },
        required: ["id", "signal", "counterintuitive", "connects", "connects_to", "india", "commentary_potential", "topic", "company", "reason"],
      },
    },
  },
  required: ["results"],
};

function describeForScoring(c: Candidate): string {
  const also = c.variants.length ? `\n   also reported as: ${c.variants.map((v) => truncate(v, 110)).join(" | ")}` : "";
  const summary = c.summary ? `\n   summary: ${truncate(c.summary, 280)}` : "";
  return `[${c.id}] ${c.headline}\n   outlets: ${c.outlets} (${c.publishers.slice(0, 4).join(", ")})${also}${summary}`;
}

async function scoreBatch(all: Candidate[], only?: Set<number>): Promise<number> {
  const batch = all.filter((c) => !c.gemini && (!only || only.has(c.id))).slice(0, SCORE_BATCH);
  if (batch.length === 0) return 0;

  const context = all.map((c) => `[${c.id}] ${truncate(c.headline, 100)}`).join("\n");
  const { results, _model } = await generateJson<{ results: (GeminiScores & { id: number })[] }>({
    system: scoreSystem(),
    prompt: `THIS WEEK'S FULL STORY LIST (context for "connects"):\n${context}\n\nSCORE THESE ${batch.length} STORIES:\n\n${batch.map(describeForScoring).join("\n\n")}`,
    schema: SCORE_SCHEMA,
    thinking: "medium",
  });

  const ids = new Set(batch.map((c) => c.id));
  const scored = results.filter((r) => ids.has(Number(r.id)));
  for (const r of scored) {
    const { id, ...scores } = r;
    await query("update stories set scores = $2, topic = $3, company = $4, scored_at = now() where id = $1", [
      Number(id),
      JSON.stringify(scores),
      scores.topic,
      scores.company,
    ]);
  }
  console.log(`scored ${scored.length}/${batch.length} stories with ${_model}`);
  // If Gemini skipped some ids, don't loop on them forever: give them a zero score.
  const missing = batch.filter((c) => !scored.some((r) => Number(r.id) === c.id));
  for (const c of missing) {
    const zero = { signal: 0, counterintuitive: 0, connects: 0, connects_to: 0, india: 0, commentary_potential: 0, topic: c.topic, company: "", reason: "not scored" };
    await query("update stories set scores = $2, scored_at = now() where id = $1", [c.id, JSON.stringify(zero)]);
  }
  return batch.length;
}

// ---------------------------------------------------------------- B. selection

const companyKey = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, "");
const isRealCompany = (c: string) => !!companyKey(c) && !["none", "various", "multiple", "na", "india", "government"].includes(companyKey(c));

/** Returns every selection rule the pick breaks (empty = valid). */
export function validateSelection(ids: number[], byId: Map<number, Candidate>, covered: Set<number>, pinned: Set<number> = new Set()): string[] {
  const errors: string[] = [];
  const missingPins = [...pinned].filter((id) => !ids.includes(id));
  if (missingPins.length) errors.push(`Shreya pinned these stories and they must be included: ${missingPins.join(", ")}`);
  if (ids.length < SELECTION.min || ids.length > SELECTION.max) {
    errors.push(`picked ${ids.length} stories; must be ${SELECTION.min}-${SELECTION.max}`);
  }
  if (new Set(ids).size !== ids.length) errors.push("the same story id appears twice");
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) errors.push(`ids not in the shortlist: ${unknown.join(", ")}`);
  const repeats = ids.filter((id) => covered.has(id));
  if (repeats.length) errors.push(`already covered in the last ${SELECTION.lookbackIssues} issues: ${repeats.join(", ")}`);

  const picked = ids.map((id) => byId.get(id)).filter((c): c is Candidate => !!c);
  const perTopic = new Map<string, number>();
  for (const c of picked) perTopic.set(c.topic, (perTopic.get(c.topic) ?? 0) + 1);
  if (perTopic.size < SELECTION.minTopics) {
    errors.push(`only ${perTopic.size} topics (${[...perTopic.keys()].join(", ")}); need at least ${SELECTION.minTopics}`);
  }
  for (const [topic, n] of perTopic) {
    if (n > SELECTION.maxPerTopic) errors.push(`${n} stories from topic "${topic}"; max ${SELECTION.maxPerTopic}`);
  }
  const perCompany = new Map<string, number[]>();
  for (const c of picked) {
    if (!isRealCompany(c.company)) continue;
    const k = companyKey(c.company);
    perCompany.set(k, [...(perCompany.get(k) ?? []), c.id]);
  }
  for (const [, group] of perCompany) {
    if (group.length > SELECTION.maxPerCompany) errors.push(`stories ${group.join(", ")} are about the same company; max ${SELECTION.maxPerCompany}`);
  }
  return errors;
}

/** Deterministic fallback: best scores first, respecting every rule. */
export function greedySelect(ranked: Candidate[], pinned: Set<number> = new Set()): number[] {
  // Shreya's pins go in first, whatever their score.
  const pick: Candidate[] = ranked.filter((c) => pinned.has(c.id)).slice(0, SELECTION.max);
  const topicCount = (t: string) => pick.filter((c) => c.topic === t).length;
  const companyUsed = (c: Candidate) => isRealCompany(c.company) && pick.some((p) => companyKey(p.company) === companyKey(c.company));

  for (const c of ranked) {
    if (pick.length >= SELECTION.target) break;
    if (pick.includes(c)) continue;
    if (topicCount(c.topic) < SELECTION.maxPerTopic && !companyUsed(c)) pick.push(c);
  }
  // Too few topics: swap the weakest story of the most common topic for the best story of a new topic.
  while (new Set(pick.map((c) => c.topic)).size < SELECTION.minTopics) {
    const fresh = ranked.find((c) => !pick.includes(c) && topicCount(c.topic) === 0 && !companyUsed(c));
    if (!fresh) break;
    const counts = [...new Set(pick.map((c) => c.topic))].map((t) => [t, topicCount(t)] as const).sort((a, b) => b[1] - a[1]);
    const victim = [...pick].reverse().find((c) => c.topic === counts[0][0] && !pinned.has(c.id));
    if (!victim) break;
    pick.splice(pick.indexOf(victim), 1, fresh);
  }
  return pick.map((c) => c.id);
}

const selectSystem = () => `You are Shreya, editor of "The Dispatch". From the shortlist, pick this week's stories.

Rules (all mandatory):
- pick ${SELECTION.min}-${SELECTION.max} stories (aim for ${SELECTION.target})
- at least ${SELECTION.minTopics} different topics, at most ${SELECTION.maxPerTopic} stories from any one topic
- at most ${SELECTION.maxPerCompany} story per company
- never pick a story that repeats one from the recently covered list
- every story Shreya pinned must be in the pick

Prefer high scores, but use judgement: favour stories that are counterintuitive, under-reported or that connect
to each other, and avoid an issue that is all funding rounds. Order the picks as they should run (strongest lead first).
Then list a bench of ${SELECTION.bench} next-best stories (not in your pick) for swaps.`;

const SELECT_SCHEMA = {
  type: "object",
  properties: {
    selected: { type: "array", items: { type: "integer" } },
    bench: { type: "array", items: { type: "integer" } },
    rationale: { type: "string" },
  },
  required: ["selected", "bench", "rationale"],
};

function describeForSelection(c: Candidate): string {
  const s = c.criteria!;
  const link = c.gemini?.connects_to ? ` · connects to [${c.gemini.connects_to}]` : "";
  return `[${c.id}] ${c.headline}
   topic: ${c.topic} · company: ${c.company || "-"} · score ${c.score} (signal ${s.signal}, counter ${s.counterintuitive}, under-reported ${s.under_reported}, connects ${s.connects}, india ${s.india}, potential ${s.commentary_potential})${link}
   why: ${c.gemini?.reason ?? ""}`;
}

async function selectStories(issue: Issue, candidates: Candidate[], covered: { id: number; headline: string }[]) {
  const coveredIds = new Set(covered.map((c) => c.id));
  // Stories Shreya blocked never reach Gemini; the ones she pinned always make the shortlist.
  const ranked = candidates.filter((c) => c.criteria && !coveredIds.has(c.id) && c.flag !== "block").sort((a, b) => b.score - a.score);
  const pinnedStories = ranked.filter((c) => c.flag === "pin").slice(0, SELECTION.max);
  const pinned = new Set(pinnedStories.map((c) => c.id));
  const shortlist = [...pinnedStories, ...ranked.filter((c) => !pinned.has(c.id))].slice(0, Math.max(SELECTION.shortlist, pinned.size));
  shortlist.sort((a, b) => b.score - a.score);
  const byId = new Map(shortlist.map((c) => [c.id, c]));

  const coveredText = covered.length ? covered.map((c) => `- ${c.headline}`).join("\n") : "(none yet)";
  const pinText = pinned.size ? `\n\nPINNED BY SHREYA (must be in your pick): ${[...pinned].join(", ")}` : "";
  const basePrompt = `RECENTLY COVERED (last ${SELECTION.lookbackIssues} issues):\n${coveredText}${pinText}\n\nSHORTLIST (top ${shortlist.length} by rubric score):\n\n${shortlist.map(describeForSelection).join("\n\n")}`;

  const log: Record<string, unknown>[] = [];
  let selected: number[] = [];
  let bench: number[] = [];
  let rationale = "";
  let errors: string[] = ["not attempted"];

  for (let attempt = 0; attempt <= SELECTION.repairAttempts && errors.length; attempt++) {
    const repair = attempt === 0 ? "" : `\n\nYOUR PREVIOUS PICK ${JSON.stringify(selected)} BROKE THESE RULES — fix them:\n- ${errors.join("\n- ")}`;
    const res = await generateJson<{ selected: number[]; bench: number[]; rationale: string }>({
      system: selectSystem(),
      prompt: basePrompt + repair,
      schema: SELECT_SCHEMA,
      thinking: attempt === 0 ? "high" : "medium",
    });
    selected = res.selected.map(Number);
    bench = res.bench.map(Number);
    rationale = res.rationale;
    errors = validateSelection(selected, byId, coveredIds, pinned);
    log.push({ attempt, model: res._model, selected, errors });
  }

  let method = "gemini";
  if (errors.length) {
    selected = greedySelect(ranked, pinned);
    method = "greedy-fallback";
    log.push({ fallback: true, selected, errors: validateSelection(selected, new Map(ranked.map((c) => [c.id, c])), coveredIds, pinned) });
  }

  // Bench: Gemini's suggestions first, topped up from the ranking; never a selected or covered story.
  const benchIds = [...bench, ...ranked.map((c) => c.id)]
    .filter((id, i, arr) => arr.indexOf(id) === i && !selected.includes(id) && !coveredIds.has(id) && ranked.some((c) => c.id === id))
    .slice(0, SELECTION.bench);

  const all = new Map(candidates.map((c) => [c.id, c]));
  const rows = [
    ...selected.map((id, i) => ({ c: all.get(id)!, role: "selected", position: i + 1 })),
    ...benchIds.map((id, i) => ({ c: all.get(id)!, role: "bench", position: i + 1 })),
  ];
  for (const { c, role, position } of rows) {
    const [article] = await query<{ id: number }>(
      "select id from articles where story_id = $1 order by (url like 'https://news.google.com/%'), id limit 1",
      [c.id],
    );
    await query(
      `insert into issue_items (issue_id, story_id, article_id, role, position, topic, reason, score)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (issue_id, story_id) do nothing`,
      [issue.id, c.id, article.id, role, position, c.topic, c.gemini?.reason ?? null, c.score],
    );
  }
  await query("update issues set selection_log = $2 where id = $1", [issue.id, JSON.stringify({ method, rationale, pinned: [...pinned], attempts: log })]);
  for (const c of candidates) if (c.criteria) await query("update stories set score = $2 where id = $1", [c.id, c.score]);
  console.log(`selected ${selected.length} stories via ${method}; bench ${benchIds.length}`);
  return { method, selected, bench: benchIds, rationale };
}

// ---------------------------------------------------------------- C. commentary

type ItemForWriting = {
  item_id: number;
  story_id: number;
  role: "selected" | "bench";
  headline: string;
  topic: Topic;
  reason: string | null;
  commentary: string | null;
};

const writeInstructions = () => `You draft The Dispatch in Shreya's voice. Follow the voice guide exactly.

For each story write commentary: ${COMMENTARY.minSentences}-${COMMENTARY.maxSentences} sentences, ${COMMENTARY.minWords}-${COMMENTARY.maxWords} words.
Line 1 says why it matters (never restate the headline). Line 2 gives the non-obvious angle. Optional line 3: a pointed question or prediction.
Use ONLY facts present in the provided headlines and summaries. Do not invent numbers, names or quotes.
Money format: ₹450 Cr, ₹1.2 lakh Cr, $75 Mn, $2 Bn. No emojis, no exclamation marks, no hashtags, no banned words.`;

export type EditExample = { headline: string; before: string; after: string };

/**
 * Shreya's most recent hand edits (the AI's version → what she published), newest first.
 * Typo-level touch-ups are skipped: only edits that change the substance teach anything.
 */
export async function editExamples(limit = 6): Promise<EditExample[]> {
  const rows = await query<EditExample>(
    `select s.headline, coalesce(ii.checks->>'ai_version', ii.original_commentary) as before, ii.commentary as after
     from issue_items ii join stories s on s.id = ii.story_id
     where ii.edited_by_shreya and coalesce(ii.checks->>'ai_version', ii.original_commentary) is not null
       and length(ii.commentary) > 20
     order by ii.updated_at desc limit $1`,
    [limit * 3],
  );
  return rows.filter((r) => r.before.trim() && trigramSimilarity(r.before, r.after) < 0.9).slice(0, limit);
}

/** The voice guide plus her recent edits, appended to every drafting and rewriting prompt. */
async function voiceContext(): Promise<string> {
  const [guide, edits] = await Promise.all([getStyleGuide(), editExamples()]);
  if (!edits.length) return `VOICE GUIDE:\n${guide}`;
  const examples = edits
    .map((e, i) => `${i + 1}. Story: ${truncate(e.headline, 120)}\n   Your draft: ${e.before}\n   Shreya's version: ${e.after}`)
    .join("\n");
  return `VOICE GUIDE:\n${guide}\n\nHOW SHREYA HAS EDITED RECENT DRAFTS (her version is what she published). Learn what she changes:
the angle she prefers, what she cuts, how she phrases things. Match her style; never reuse her sentences.\n${examples}`;
}

const WRITE_SCHEMA = {
  type: "object",
  properties: {
    subject_hook: { type: "string", description: "the sharpest story of the week in under 8 words" },
    intro: { type: "string", description: "2-3 sentence opening: what connects this week's stories" },
    items: {
      type: "array",
      items: { type: "object", properties: { id: { type: "integer" }, commentary: { type: "string" } }, required: ["id", "commentary"] },
    },
  },
  required: ["subject_hook", "intro", "items"],
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          angle: { type: "integer", minimum: 1, maximum: 5 },
          voice: { type: "integer", minimum: 1, maximum: 5 },
          grounded: { type: "integer", minimum: 1, maximum: 5 },
          forwardable: { type: "integer", minimum: 1, maximum: 5 },
          note: { type: "string" },
        },
        required: ["id", "angle", "voice", "grounded", "forwardable", "note"],
      },
    },
  },
  required: ["reviews"],
};

type Review = { id: number; angle: number; voice: number; grounded: number; forwardable: number; note: string };
const reviewAverage = (r: Review) => (r.angle + r.voice + r.grounded + r.forwardable) / 4;

async function storySources(storyIds: number[]): Promise<Map<number, string>> {
  const rows = await query<{ story_id: number; source: string }>(
    `select story_id, string_agg(distinct '- ' || title || coalesce(' — ' || nullif(left(summary, 300), ''), '') || ' (' || publisher || ')', E'\\n') as source
     from articles where story_id = any($1::bigint[]) group by story_id`,
    [storyIds],
  );
  return new Map(rows.map((r) => [Number(r.story_id), r.source]));
}

async function review(items: { id: number; headline: string; commentary: string }[], sources: Map<number, string>, guide: string) {
  const { reviews, _model } = await generateJson<{ reviews: Review[] }>({
    system: `You are a strict copy editor for The Dispatch. Score each commentary 1-5:
angle (non-obvious, more than a summary), voice (matches the voice guide), grounded (every fact appears in the sources;
1 if anything is invented), forwardable (would a founder forward it to their co-founder). Give a short note on the main weakness.

VOICE GUIDE:
${guide}`,
    prompt: items
      .map((i) => `[${i.id}] HEADLINE: ${i.headline}\nSOURCES:\n${sources.get(i.id) ?? ""}\nCOMMENTARY: ${i.commentary}`)
      .join("\n\n"),
    schema: REVIEW_SCHEMA,
    thinking: "medium",
  });
  console.log(`reviewed ${reviews.length} commentaries with ${_model}`);
  return new Map(reviews.map((r) => [Number(r.id), r]));
}

// Commentary moves through stages (stored in issue_items.checks.stage), one Gemini call per step,
// so each step fits inside a single serverless invocation:
//   (none) → drafted → final | needs_rewrite → rewritten → final
type Stage = "drafted" | "needs_rewrite" | "rewritten" | "final";
type ItemState = ItemForWriting & { checks: (Record<string, unknown> & { stage?: Stage; review?: Review; problems?: string[] }) | null };

async function loadItems(issueId: number): Promise<ItemState[]> {
  return query<ItemState>(
    `select ii.id as item_id, ii.story_id, ii.role, s.headline, ii.topic, ii.reason, ii.commentary, ii.checks
     from issue_items ii join stories s on s.id = ii.story_id
     where ii.issue_id = $1 order by ii.role desc, ii.position`,
    [issueId],
  );
}

function problemsFor(commentary: string, headline: string, r: Review | undefined): string[] {
  const problems = [...checkCommentary(commentary, headline).failures];
  if (r && reviewAverage(r) < COMMENTARY.minReviewAverage) {
    problems.push(`review average ${reviewAverage(r).toFixed(2)} < ${COMMENTARY.minReviewAverage}: ${r.note}`);
  }
  if (r && r.grounded <= 2) problems.push(`not grounded in sources: ${r.note}`);
  return problems;
}

async function saveItem(item: ItemState, fields: { commentary?: string; original?: string; stage: Stage; review?: Review; problems?: string[] }) {
  const commentary = fields.commentary ?? item.commentary ?? "";
  const checks = {
    ...(item.checks ?? {}),
    ...checkCommentary(commentary, item.headline),
    stage: fields.stage,
    ...(fields.review ? { review: fields.review } : {}),
    ...(fields.problems ? { problems: fields.problems } : {}),
    ...(fields.stage === "rewritten" ? { rewritten: true } : {}),
  };
  await query(
    `update issue_items set commentary = $2, original_commentary = coalesce(original_commentary, $3), checks = $4, flagged = $5, updated_at = now()
     where id = $1`,
    [item.item_id, commentary, fields.original ?? commentary, JSON.stringify(checks), fields.stage === "final" && (fields.problems?.length ?? 0) > 0],
  );
}

/** Runs the next commentary step for the issue. Returns a label for what it did, or null when all items are final. */
async function commentaryStep(issue: Issue): Promise<string | null> {
  const items = await loadItems(issue.id);
  const stageOf = (i: ItemState): Stage | "new" => (i.commentary ? (i.checks?.stage ?? "final") : "new");
  const guide = await getStyleGuide();
  const voice = await voiceContext();
  const sources = await storySources(items.map((i) => Number(i.story_id)));
  const describe = (i: ItemState, extra = "") =>
    `[${i.story_id}] HEADLINE: ${i.headline}\nTOPIC: ${TOPICS[i.topic] ?? i.topic}\nWHY IT WAS PICKED: ${i.reason ?? ""}\nSOURCES:\n${sources.get(Number(i.story_id)) ?? ""}${extra}`;

  // 1) Draft every item without commentary (plus subject hook and intro) in one call.
  const fresh = items.filter((i) => stageOf(i) === "new");
  if (fresh.length) {
    const lineup = items.filter((i) => i.role === "selected").map((i) => `- ${i.headline}`).join("\n");
    const draft = await generateJson<{ subject_hook: string; intro: string; items: { id: number; commentary: string }[] }>({
      system: `${writeInstructions()}\n\n${voice}`,
      prompt: `This week's lineup (for the intro):\n${lineup}\n\nWrite commentary for each story below, plus the subject hook and intro.\n\n${fresh.map((i) => describe(i)).join("\n\n")}`,
      schema: WRITE_SCHEMA,
      thinking: "medium",
    });
    for (const d of draft.items) {
      const item = fresh.find((i) => Number(i.story_id) === Number(d.id));
      if (item) await saveItem(item, { commentary: d.commentary.trim(), stage: "drafted" });
    }
    // Anything Gemini skipped gets flagged rather than retried forever.
    for (const item of fresh.filter((i) => !draft.items.some((d) => Number(d.id) === Number(i.story_id)))) {
      await saveItem(item, { commentary: "", stage: "final", problems: ["Gemini returned no commentary — write this one by hand"] });
    }
    await query("update issues set subject = $2, intro = $3 where id = $1", [
      issue.id,
      `The Dispatch #${issue.issue_number} — ${draft.subject_hook.trim().replace(/[.!]+$/, "")}`,
      draft.intro.trim(),
    ]);
    return `drafted ${draft.items.length} with ${draft._model}`;
  }

  // 2) Review drafted (or rewritten) items: code checks + Gemini self-review.
  const toReview = items.filter((i) => stageOf(i) === "drafted" || stageOf(i) === "rewritten");
  if (toReview.length) {
    const reviews = await review(
      toReview.map((i) => ({ id: Number(i.story_id), headline: i.headline, commentary: i.commentary! })),
      sources,
      guide,
    );
    for (const item of toReview) {
      const r = reviews.get(Number(item.story_id));
      const problems = problemsFor(item.commentary!, item.headline, r);
      // Drafts that fail get one rewrite; rewrites that still fail are final but flagged for Shreya.
      const stage: Stage = problems.length && stageOf(item) === "drafted" ? "needs_rewrite" : "final";
      await saveItem(item, { stage, review: r, problems });
    }
    return `reviewed ${toReview.length}`;
  }

  // 3) Rewrite the failures once.
  const toFix = items.filter((i) => stageOf(i) === "needs_rewrite");
  if (toFix.length) {
    const [current] = await query<{ subject: string; intro: string }>("select subject, intro from issues where id = $1", [issue.id]);
    const rewrite = await generateJson<{ subject_hook: string; intro: string; items: { id: number; commentary: string }[] }>({
      system: `${writeInstructions()}\n\n${voice}`,
      prompt: `Rewrite the commentary for these stories, fixing every listed problem. Return the subject hook and intro unchanged.\nSUBJECT: ${current.subject}\nINTRO: ${current.intro}\n\n${toFix
        .map((i) => describe(i, `\nPREVIOUS COMMENTARY: ${i.commentary}\nPROBLEMS:\n- ${(i.checks?.problems ?? []).join("\n- ")}`))
        .join("\n\n")}`,
      schema: WRITE_SCHEMA,
      thinking: "high",
    });
    for (const item of toFix) {
      const r = rewrite.items.find((d) => Number(d.id) === Number(item.story_id));
      // If Gemini skipped it, keep the old text and send it straight to the final review.
      await saveItem(item, { commentary: r?.commentary.trim() ?? item.commentary!, stage: "rewritten" });
    }
    return `rewrote ${toFix.length} with ${rewrite._model}`;
  }

  return null;
}

// ---------------------------------------------------------------- pipeline

/** Runs the Wednesday editorial pass (resumable). Only ever produces a draft; nothing is sent. */
export async function draftIssue({ budgetMs = Infinity, week = weekStart() } = {}) {
  const deadline = Date.now() + budgetMs;
  await loadRubric();
  const issue = await ensureIssue(week);
  if (issue.status !== "collecting") return { week, issue: issue.id, status: issue.status, note: "already drafted" };

  const stages: Record<string, unknown> = {};

  // A. score
  let candidates = await loadCandidates(week);
  let scored = 0;
  for (let n; Date.now() < deadline && (n = await scoreBatch(candidates)); ) {
    scored += n;
    candidates = await loadCandidates(week);
  }
  stages.scored = scored;
  const unscored = candidates.filter((c) => !c.gemini).length;
  if (unscored) return { week, issue: issue.id, status: "collecting", stages, unscored, note: "out of time; run again" };

  // B. select
  const [{ items }] = await query<{ items: number }>("select count(*)::int as items from issue_items where issue_id = $1", [issue.id]);
  if (items === 0) {
    if (Date.now() >= deadline) return { week, issue: issue.id, status: "collecting", stages, note: "out of time; run again" };
    stages.selection = await selectStories(issue, candidates, await loadCovered(week));
  }

  // C. commentary (one Gemini call per step)
  const steps: string[] = [];
  for (let step; ; ) {
    if (Date.now() >= deadline) return { week, issue: issue.id, status: "collecting", stages: { ...stages, commentary: steps }, note: "out of time; run again" };
    if (!(step = await commentaryStep(issue))) break;
    console.log(step);
    steps.push(step);
  }
  stages.commentary = steps;

  await query("update issues set status = 'drafted', drafted_at = now() where id = $1 and status = 'collecting'", [issue.id]);
  await logEvent("drafted", { week, stages }, issue.id);

  // A fresh draft that replaced one already in Telegram goes straight back to Shreya.
  const [{ redeliver }] = await query<{ redeliver: boolean }>("select redeliver from issues where id = $1", [issue.id]);
  if (redeliver) {
    await query("update issues set redeliver = false where id = $1", [issue.id]);
    const { deliverDraft } = await import("./review"); // lazy: review.ts imports this module
    stages.redelivered = await deliverDraft(week);
  }
  return { week, issue: issue.id, status: "drafted", stages };
}


// ---------------------------------------------------------------- on-demand rewrite (Telegram)

/** Rewrites one story's commentary (Telegram "♻️ Rewrite" or "/ai <instruction>"). */
export async function rewriteCommentary(itemId: number, instruction?: string): Promise<{ commentary: string; failures: string[] }> {
  await loadRubric();
  const [item] = await query<ItemState>(
    `select ii.id as item_id, ii.story_id, ii.role, s.headline, ii.topic, ii.reason, ii.commentary, ii.checks
     from issue_items ii join stories s on s.id = ii.story_id where ii.id = $1`,
    [itemId],
  );
  if (!item) throw new Error(`issue item ${itemId} not found`);
  const voice = await voiceContext();
  const sources = await storySources([Number(item.story_id)]);
  const ask = instruction ? `Shreya's instruction for this rewrite: "${truncate(instruction, 300)}"` : "Find a sharper, less obvious angle than the current version.";
  const res = await generateJson<{ commentary: string }>({
    system: `${writeInstructions()}\n\n${voice}`,
    prompt: `${item.commentary?.trim() ? "Rewrite the commentary for this story." : "Write the commentary for this story."} ${ask}\n\nHEADLINE: ${item.headline}\nWHY IT WAS PICKED: ${item.reason ?? ""}\nSOURCES:\n${sources.get(Number(item.story_id)) ?? ""}\nCURRENT COMMENTARY: ${item.commentary ?? ""}`,
    schema: { type: "object", properties: { commentary: { type: "string" } }, required: ["commentary"] },
    thinking: "medium",
  });
  const commentary = res.commentary.trim();
  const checks = checkCommentary(commentary, item.headline);
  await query(
    `update issue_items set commentary = $2, checks = coalesce(checks, '{}'::jsonb) || $3::jsonb, flagged = $4, edited_by_shreya = false, updated_at = now()
     where id = $1`,
    [itemId, commentary, JSON.stringify({ ...checks, stage: "final", problems: checks.failures, rewritten_on_request: true }), checks.failures.length > 0],
  );
  return { commentary, failures: checks.failures };
}

// ---------------------------------------------------------------- scoring outside the Wednesday run

/** Scores stories that arrived after the draft (dashboard "Score new stories"). Doesn't touch the lineup. */
export async function scoreNewStories({ budgetMs = Infinity, week = weekStart() } = {}) {
  const deadline = Date.now() + budgetMs;
  await loadRubric();
  let candidates = await loadCandidates(week);
  let scored = 0;
  for (let n; Date.now() < deadline && (n = await scoreBatch(candidates)); ) {
    scored += n;
    candidates = await loadCandidates(week);
  }
  // Refresh every weighted total: outlet counts (the "under-reported" criterion) change as articles arrive.
  for (const c of candidates) if (c.criteria) await query("update stories set score = $2 where id = $1", [c.id, c.score]);
  const unscored = candidates.filter((c) => !c.gemini).length;
  await logEvent("scored_new_stories", { week, scored, unscored });
  return { week, scored, unscored, complete: unscored === 0 };
}

/** Scores particular stories straight away (a story Shreya added from a link). One Gemini request. */
export async function scoreStories(storyIds: number[], week = weekStart()) {
  await loadRubric();
  const ids = new Set(storyIds.map(Number));
  await scoreBatch(await loadCandidates(week), ids);
  const fresh = (await loadCandidates(week)).filter((c) => ids.has(c.id));
  for (const c of fresh) if (c.criteria) await query("update stories set score = $2 where id = $1", [c.id, c.score]);
  return fresh.map((c) => ({ id: c.id, score: c.score, scored: !!c.criteria, topic: c.topic }));
}

/**
 * Recomputes every weighted total for the week from the stored criterion scores (no Gemini calls).
 * Run after the rubric's weights or penalty change, so rankings reflect the new rubric straight away.
 */
export async function refreshTotals(week = weekStart()) {
  await loadRubric(true);
  const scored = (await loadCandidates(week)).filter((c) => c.criteria);
  await query(
    "update stories s set score = v.score from unnest($1::bigint[], $2::numeric[]) as v(id, score) where s.id = v.id",
    [scored.map((c) => c.id), scored.map((c) => c.score)],
  );
  await query(
    `update issue_items ii set score = s.score from stories s
     where s.id = ii.story_id and ii.issue_id in (select id from issues where week_start = $1)`,
    [week],
  );
  return { updated: scored.length };
}
