// Editorial rubric. These objects hold the *live* values: they start as the defaults below and are
// overwritten in place by applyRubric() with whatever Shreya last saved on the dashboard
// (loaded per request by loadRubric() in rubric-store.ts). Documented in editorial-rubric.md.
import { normalizePublisher, trigramSimilarity } from "./text";

export const CRITERION_KEYS = ["signal", "counterintuitive", "under_reported", "connects", "india", "commentary_potential"] as const;
export type Criterion = (typeof CRITERION_KEYS)[number];

type CriterionDef = {
  weight: number;
  label: string;
  /** The question the scorer answers. */
  question: string;
  /** Why it matters to The Dispatch. */
  why: string;
  scoredBy: "Gemini Flash" | "Code";
  /** What a 0, 3 and 5 look like (1, 2 and 4 sit in between). Also used verbatim in the Gemini prompt. */
  anchors: { 0: string; 3: string; 5: string };
};

// Single source of truth for the rubric: the dashboard explainer and the Gemini scoring prompt both read this.
export const CRITERIA: Record<Criterion, CriterionDef> = {
  signal: {
    weight: 0.3,
    label: "Signal",
    question: "Does this change where money, regulation, talent or users are actually moving?",
    why: "Shreya's readers want developments that matter, not press releases. Signal carries the most weight.",
    scoredBy: "Gemini Flash",
    anchors: {
      0: "PR, a routine update or a minor announcement",
      3: "a notable move for one company",
      5: "a sector-level shift, a precedent or an inflection point",
    },
  },
  counterintuitive: {
    weight: 0.2,
    label: "Counterintuitive",
    question: "Does it cut against what most people in the ecosystem currently believe?",
    why: "Stories that surprise are the core of The Dispatch's curation.",
    scoredBy: "Gemini Flash",
    anchors: {
      0: "confirms the obvious",
      3: "adds a twist to the usual narrative",
      5: "flips a common belief, with evidence",
    },
  },
  under_reported: {
    weight: 0.15,
    label: "Under-reported",
    question: "How many different outlets covered it this week?",
    why: "If everyone ran it, the reader has already seen it. Fewer outlets means more value in surfacing it.",
    scoredBy: "Code",
    anchors: {
      0: "10 or more outlets covered it",
      3: "3 outlets covered it",
      5: "only 1 outlet covered it",
    },
  },
  connects: {
    weight: 0.15,
    label: "Connects trends",
    question: "Does it link to another story this week, or to a trend nobody has put side by side with it?",
    why: "Connecting two trends nobody else has linked is one of Shreya's signatures.",
    scoredBy: "Gemini Flash",
    anchors: {
      0: "stands alone",
      3: "fits a known trend",
      5: "links to another story in this week's list that nobody has paired it with",
    },
  },
  india: {
    weight: 0.1,
    label: "India relevance",
    question: "How directly does it affect Indian founders, investors or users?",
    why: "The Dispatch covers the Indian startup ecosystem; global stories need a real India angle.",
    scoredBy: "Gemini Flash",
    anchors: {
      0: "barely touches India",
      3: "affects one Indian segment",
      5: "directly changes things for Indian founders, investors or users",
    },
  },
  commentary_potential: {
    weight: 0.1,
    label: "Commentary potential",
    question: "Is there a sharp, specific take to write in two or three lines?",
    why: "Every story needs commentary worth forwarding; some stories leave nothing to add.",
    scoredBy: "Gemini Flash",
    anchors: {
      0: "nothing to add beyond the headline",
      3: "a decent angle exists",
      5: "concrete numbers and names, and a sharp take is obvious",
    },
  },
};

/** Points a criterion contributes to the 100-point total. */
export function criterionPoints(criterion: Criterion, score: number): number {
  return Math.round(CRITERIA[criterion].weight * (Math.max(0, Math.min(5, score)) / 5) * 1000) / 10;
}

export const UNDER_REPORTED_SCALE = [
  { outlets: "1", score: 5 },
  { outlets: "2", score: 4 },
  { outlets: "3", score: 3 },
  { outlets: "4–5", score: 2 },
  { outlets: "6–9", score: 1 },
  { outlets: "10+", score: 0 },
];
export type CriterionScores = Record<Criterion, number>;

export const SCORING = { weakSourcingPenalty: 10 };

export const SELECTION = {
  min: 8,
  max: 10,
  target: 9,
  minTopics: 3,
  maxPerTopic: 3,
  maxPerCompany: 1,
  shortlist: 25,
  bench: 10,
  repairAttempts: 2,
  lookbackIssues: 4,
};

export const COMMENTARY = {
  minSentences: 2,
  maxSentences: 3,
  minWords: 40,
  maxWords: 70,
  maxHeadlineSimilarity: 0.5,
  minReviewAverage: 4,
};

/** Distinct outlets → 0–5 (fewer outlets = more under-reported). */
export function underReportedScore(outlets: number): number {
  if (outlets <= 1) return 5;
  if (outlets === 2) return 4;
  if (outlets === 3) return 3;
  if (outlets <= 5) return 2;
  if (outlets <= 9) return 1;
  return 0;
}

const RECOGNISED_OUTLETS = [
  "economictimes", "ettech", "etstartups", "etnow", "livemint", "mint", "inc42", "yourstory", "entrackr", "moneycontrol",
  "businessstandard", "medianama", "morningcontext", "vccircle", "techcircle", "techcrunch", "restofworld", "thehindu",
  "businessline", "reuters", "bloomberg", "financialexpress", "cnbctv18", "ndtvprofit", "ndtv", "businesstoday",
  "forbesindia", "fortuneindia", "indianexpress", "hindustantimes", "timesofindia", "theken", "outlookbusiness",
  "deccanherald", "indiatoday", "thehindubusinessline", "firstpost", "theprint", "scroll", "analyticsindiamag",
];

export function isRecognisedOutlet(publisher: string): boolean {
  const n = normalizePublisher(publisher);
  return n === "et" || RECOGNISED_OUTLETS.some((k) => n.includes(k));
}

/** Weighted total out of 100, minus the weak-sourcing penalty. */
export function weightedScore(scores: CriterionScores, weakSourcing: boolean): number {
  let total = 0;
  for (const [key, { weight }] of Object.entries(CRITERIA) as [Criterion, { weight: number }][]) {
    total += weight * (Math.max(0, Math.min(5, scores[key])) / 5);
  }
  return Math.round((total * 100 - (weakSourcing ? SCORING.weakSourcingPenalty : 0)) * 10) / 10;
}

// ---- Commentary checks (rubric part C, code half) ----

const BANNED = [
  "game-changer", "game changer", "game-changing", "disruptive", "revolutionary", "unicorn-in-the-making", "skyrocket",
  "massive", "huge", "delve", "landscape", "abuzz", "fast-paced", "it remains to be seen", "only time will tell",
  "navigate", "unlock", "leverage", "robust", "a testament to", "you won't believe",
];

export type CommentaryChecks = {
  sentences: number;
  words: number;
  headlineSimilarity: number;
  failures: string[];
};

export type CommentaryLimits = Pick<typeof COMMENTARY, "minSentences" | "maxSentences" | "minWords" | "maxWords">;

/** `limits` lets the browser run the checks with the server's live limits. */
export function checkCommentary(commentary: string, headline: string, limits: CommentaryLimits = COMMENTARY): CommentaryChecks {
  const text = commentary.trim();
  const sentences = text.split(/(?<=[.?!])\s+(?=[A-Z₹$"'‘“0-9])/).filter((s) => s.trim().length > 0);
  const words = text.split(/\s+/).filter(Boolean).length;
  const headlineSimilarity = Math.round(trigramSimilarity(sentences[0] ?? "", headline) * 100) / 100;
  const failures: string[] = [];

  if (sentences.length < limits.minSentences || sentences.length > limits.maxSentences) {
    failures.push(`has ${sentences.length} sentences (needs ${limits.minSentences}-${limits.maxSentences})`);
  }
  if (words < limits.minWords || words > limits.maxWords) {
    failures.push(`has ${words} words (needs ${limits.minWords}-${limits.maxWords})`);
  }
  if (headlineSimilarity >= COMMENTARY.maxHeadlineSimilarity) failures.push("first sentence restates the headline");
  const lower = text.toLowerCase();
  const banned = BANNED.filter((w) => lower.includes(w));
  if (banned.length) failures.push(`uses banned words: ${banned.join(", ")}`);
  if (/\p{Extended_Pictographic}/u.test(text)) failures.push("contains emoji");
  if (text.includes("!")) failures.push("contains an exclamation mark");
  if (/(^|\s)#\w/.test(text)) failures.push("contains a hashtag");
  if (/\bRs\.?\s?\d|\brupees?\b|\bcrores?\b|\blakhs?\b(?!\s*Cr)|\bmillion\b|\bbillion\b/i.test(text)) {
    failures.push("money not in ₹ Cr / $ Mn / $ Bn format");
  }
  return { sentences: sentences.length, words, headlineSimilarity, failures };
}

// ---------------------------------------------------------------- editable rubric

export type EditableCriterion = Pick<CriterionDef, "weight" | "question" | "why" | "anchors">;
export type Rubric = {
  criteria: Record<Criterion, EditableCriterion>;
  weakSourcingPenalty: number;
  selection: Pick<typeof SELECTION, "min" | "max" | "target" | "minTopics" | "maxPerTopic" | "maxPerCompany" | "shortlist" | "bench" | "lookbackIssues">;
  commentary: Pick<typeof COMMENTARY, "minSentences" | "maxSentences" | "minWords" | "maxWords" | "minReviewAverage">;
};

/** The rubric as it currently stands (live values). */
export function snapshotRubric(): Rubric {
  const criteria = {} as Rubric["criteria"];
  for (const k of CRITERION_KEYS) {
    const c = CRITERIA[k];
    criteria[k] = { weight: c.weight, question: c.question, why: c.why, anchors: { ...c.anchors } };
  }
  const { min, max, target, minTopics, maxPerTopic, maxPerCompany, shortlist, bench, lookbackIssues } = SELECTION;
  const { minSentences, maxSentences, minWords, maxWords, minReviewAverage } = COMMENTARY;
  return {
    criteria,
    weakSourcingPenalty: SCORING.weakSourcingPenalty,
    selection: { min, max, target, minTopics, maxPerTopic, maxPerCompany, shortlist, bench, lookbackIssues },
    commentary: { minSentences, maxSentences, minWords, maxWords, minReviewAverage },
  };
}

/** Captured before anything is applied, so "Restore defaults" always has the original values. */
export const DEFAULT_RUBRIC: Rubric = JSON.parse(JSON.stringify(snapshotRubric()));

export function applyRubric(r: Rubric) {
  for (const k of CRITERION_KEYS) Object.assign(CRITERIA[k], { ...r.criteria[k], anchors: { ...r.criteria[k].anchors } });
  Object.assign(SELECTION, r.selection);
  Object.assign(COMMENTARY, r.commentary);
  SCORING.weakSourcingPenalty = r.weakSourcingPenalty;
}

const int = (v: unknown) => (typeof v === "number" ? v : Number(v));

/** Checks a submitted rubric. Weights arrive as whole percentages and must total 100. */
export function validateRubric(input: Rubric): string[] {
  const errors: string[] = [];
  const weights = CRITERION_KEYS.map((k) => Math.round(int(input.criteria?.[k]?.weight) * 100));
  if (weights.some((w) => !Number.isFinite(w) || w < 0 || w > 100)) errors.push("Each weight must be between 0% and 100%.");
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum !== 100) errors.push(`Weights must add up to 100% (they add up to ${sum}%).`);
  for (const k of CRITERION_KEYS) {
    const c = input.criteria?.[k];
    const label = CRITERIA[k].label;
    if (!c?.question?.trim()) errors.push(`${label}: the question can't be empty.`);
    for (const n of [0, 3, 5] as const) if (!c?.anchors?.[n]?.trim()) errors.push(`${label}: describe what a ${n} looks like.`);
    if ([c?.question, c?.why, c?.anchors?.[0], c?.anchors?.[3], c?.anchors?.[5]].some((t) => (t ?? "").length > 240)) {
      errors.push(`${label}: keep each text under 240 characters.`);
    }
  }
  const p = int(input.weakSourcingPenalty);
  if (!Number.isInteger(p) || p < 0 || p > 50) errors.push("The weak-sourcing penalty must be a whole number from 0 to 50.");

  const s = input.selection;
  const n = (v: unknown) => Number.isInteger(int(v));
  if (![s.min, s.max, s.target, s.minTopics, s.maxPerTopic, s.maxPerCompany, s.shortlist, s.bench, s.lookbackIssues].every(n)) {
    errors.push("Lineup rules must be whole numbers.");
  } else {
    if (s.min < 1 || s.max > 15 || s.min > s.max) errors.push("Stories per issue: minimum must be at least 1, maximum at most 15, and min ≤ max.");
    if (s.target < s.min || s.target > s.max) errors.push("The target number of stories must sit between the minimum and maximum.");
    if (s.minTopics < 1 || s.minTopics > s.max) errors.push("Minimum topics must be between 1 and the maximum number of stories.");
    if (s.maxPerTopic < 1 || s.maxPerTopic * s.minTopics < s.min) {
      errors.push("Stories per topic is too low: with these rules no lineup could reach the minimum number of stories.");
    }
    if (s.maxPerCompany < 1) errors.push("Stories per company must be at least 1.");
    if (s.shortlist < s.max || s.shortlist > 60) errors.push("The shortlist must be at least the maximum number of stories (and at most 60).");
    if (s.bench < 0 || s.bench > 20) errors.push("The bench must hold between 0 and 20 stories.");
    if (s.lookbackIssues < 0 || s.lookbackIssues > 12) errors.push("Repeat protection must look back between 0 and 12 issues.");
  }

  const c = input.commentary;
  if (![c.minSentences, c.maxSentences, c.minWords, c.maxWords].every(n)) errors.push("Commentary limits must be whole numbers.");
  else {
    if (c.minSentences < 1 || c.minSentences > c.maxSentences || c.maxSentences > 8) errors.push("Sentences: min must be at least 1, at most the max, and the max at most 8.");
    if (c.minWords < 10 || c.minWords >= c.maxWords || c.maxWords > 200) errors.push("Words: min must be at least 10 and below the max (max at most 200).");
  }
  const avg = int(c.minReviewAverage);
  if (!(avg >= 1 && avg <= 5)) errors.push("The AI review bar must be between 1 and 5.");
  return errors;
}
