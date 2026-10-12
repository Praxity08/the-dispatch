// After ingestion: screen articles for relevance, embed them, and cluster duplicates into stories.
import { logEvent, query, toVector } from "./db";
import { embed, generateJson } from "./gemini";
import { normalizeTitle, trigramSimilarity, truncate } from "./text";
import { TOPIC_KEYS, TOPICS } from "./topics";
import { weekStart, weeksBefore } from "./week";

const SCREEN_BATCH = 100;
const EMBED_BATCH = 100;
// Same-story rules, calibrated on real headline pairs (2026-10-11 batch):
// - cosine >= 0.93: always the same story
// - cosine >= 0.87: same story only if the headlines share a distinctive name
//   (generic trend pieces about "AI startups in India" also score ~0.90 with each other)
// - trigram >= 0.6: near-identical normalised titles
// Then one Gemini Flash merge pass catches what these rules miss.
const SAME_STORY_COSINE = 0.93;
const CANDIDATE_COSINE = 0.87;
const SAME_STORY_TRIGRAM = 0.6;
const GENERIC_WORDS = new Set(
  `india indian indias startup startups ai raises raise raised funding fund round series seed crore cr rs mn million billion bn
  report reports says said launches launch launched announces new first second company companies firm firms tech technology
  digital platform market growth business brand brands investors investment invest led ventures capital venture ecosystem deeptech
  with from into amid after over across their about this that will could more than year years week weekly news latest exclusive
  government policy rules sales shares stock stocks ipo deal deals global expand expands back backs join joins plans plan
  commerce quick ecommerce valuation challenge native push partners prime innovation hub programme program startup's`.split(/\s+/),
);

function distinctiveWords(titleNorm: string): Set<string> {
  return new Set(titleNorm.split(" ").filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w) && !/^\d/.test(w)));
}

function sharesDistinctiveWord(a: string, b: string): boolean {
  const wa = distinctiveWords(a);
  for (const w of distinctiveWords(b)) if (wa.has(w)) return true;
  return false;
}
// Cross-issue dedup looks back over the previous four newsletters.
const LOOKBACK_WEEKS = 4;

const SCREEN_SYSTEM = `You screen news articles for "The Dispatch", a weekly newsletter about the Indian startup ecosystem.

Mark an article relevant only if it is a specific news story about:
- Indian startups, founders, new-age tech companies, or global tech companies' India business
- venture capital / private equity activity involving India, startup funding, fund launches
- IPOs, listings, earnings or valuations of Indian new-age tech companies
- government policy, regulation or court rulings that affect startups, tech or the digital economy in India
- layoffs, shutdowns, M&A or leadership changes at Indian startups / tech companies

Mark NOT relevant: general stock market or macroeconomic news, politics, sports, entertainment,
legacy conglomerates' non-tech business, non-India stories with no India angle, author/tag/listing pages,
daily or weekly news roundups/digests, opinion listicles, event promotions, and sponsored content.

Also assign the single best topic from this list:
${TOPIC_KEYS.map((k) => `- ${k}: ${TOPICS[k]}`).join("\n")}`;

const SCREEN_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          relevant: { type: "boolean" },
          topic: { type: "string", enum: TOPIC_KEYS },
        },
        required: ["id", "relevant", "topic"],
      },
    },
  },
  required: ["results"],
};

type Row = { id: number; title: string; publisher: string; summary: string };

/** Gemini Flash relevance screen + topic tag, in batches. Returns how many articles were screened. */
async function screenBatch(week: string): Promise<number> {
  const rows = await query<Row>(
    "select id, title, publisher, summary from articles where week_start = $1 and is_relevant is null order by id limit $2",
    [week, SCREEN_BATCH],
  );
  if (rows.length === 0) return 0;

  const list = rows
    .map((r) => `[${r.id}] ${r.title} (${r.publisher})${r.summary ? ` — ${truncate(r.summary, 220)}` : ""}`)
    .join("\n");
  const { results, _model } = await generateJson<{ results: { id: number; relevant: boolean; topic: string }[] }>({
    system: SCREEN_SYSTEM,
    prompt: `Screen each of these ${rows.length} articles. Return one result per id.\n\n${list}`,
    schema: SCREEN_SCHEMA,
  });

  // Neon returns bigint ids as strings; Gemini returns numbers. Compare as numbers.
  console.log(`screened ${rows.length} articles with ${_model}`);
  const byId = new Map(results.map((r) => [Number(r.id), r]));
  // Anything Gemini skipped is treated as not relevant so the batch can't loop forever.
  await query(
    `update articles a set is_relevant = v.relevant, topic = v.topic
     from unnest($1::bigint[], $2::boolean[], $3::text[]) as v(id, relevant, topic)
     where a.id = v.id`,
    [
      rows.map((r) => r.id),
      rows.map((r) => byId.get(Number(r.id))?.relevant ?? false),
      rows.map((r) => byId.get(Number(r.id))?.topic ?? "other"),
    ],
  );
  return rows.length;
}

async function embedBatch(week: string): Promise<number> {
  const rows = await query<Row>(
    "select id, title from articles where week_start = $1 and is_relevant and embedding is null order by id limit $2",
    [week, EMBED_BATCH],
  );
  if (rows.length === 0) return 0;
  const vectors = await embed(rows.map((r) => r.title));
  await query(
    `update articles a set embedding = v.embedding::vector
     from unnest($1::bigint[], $2::text[]) as v(id, embedding) where a.id = v.id`,
    [rows.map((r) => r.id), vectors.map(toVector)],
  );
  return rows.length;
}

/**
 * Attaches each new article to an existing story (this week or the last 4 weeks) or starts a new one.
 * Articles are compared with each story's seed headline only (not every member), so clusters
 * can't chain together through intermediate articles.
 */
async function clusterBatch(week: string, limit = 50): Promise<number> {
  const rows = await query<{ id: number; title: string; title_norm: string; embedding: string }>(
    `select id, title, title_norm, embedding::text from articles
     where week_start = $1 and is_relevant and embedding is not null and story_id is null
     order by published_at nulls last, id limit $2`,
    [week, limit],
  );
  for (const a of rows) await assignStory(a, week);
  return rows.length;
}

/** Puts one embedded article into the story it duplicates, or starts a new story. Returns the story id. */
export async function assignStory(a: { id: number; title: string; title_norm: string; embedding: string }, week: string): Promise<number> {
  const candidates = await query<{ id: number; headline: string; cosine: number }>(
    `select id, headline, 1 - (embedding <=> $1::vector) as cosine
     from stories where week_start >= $2
     order by embedding <=> $1::vector limit 5`,
    [a.embedding, weeksBefore(week, LOOKBACK_WEEKS)],
  );
  const match = candidates.find((c) => {
    const seed = normalizeTitle(c.headline);
    return (
      c.cosine >= SAME_STORY_COSINE ||
      trigramSimilarity(a.title_norm, seed) >= SAME_STORY_TRIGRAM ||
      (c.cosine >= CANDIDATE_COSINE && sharesDistinctiveWord(a.title_norm, seed))
    );
  });
  let storyId = match ? Number(match.id) : null;
  if (!storyId) {
    const [story] = await query<{ id: number }>(
      "insert into stories (week_start, headline, embedding) values ($1, $2, $3::vector) returning id",
      [week, a.title, a.embedding],
    );
    storyId = Number(story.id);
  }
  await query("update articles set story_id = $2 where id = $1", [a.id, storyId]);
  return storyId;
}

const MERGE_SYSTEM = `You deduplicate a newsletter's story list. Each line is one story cluster: an id, its headline,
and sometimes other headlines already grouped under it. Lines marked NEW were added since the last review.

Group together ids that report the SAME specific news development: the same company/organisation and the same
event (one funding round, one launch, one layoff, one ruling, one report, one statement).
Do NOT group:
- stories that share a theme, sector, investor or company but describe different developments
  ("Amazon festive sales" vs "Amazon layoffs"; two different startups raising money)
- different speakers, sessions or announcements at the same conference or awards event
- a digest/newsletter item with a story it merely mentions
Every group must contain at least one NEW id. Only return groups with two or more ids.
If nothing should be merged, return an empty list.`;

const MERGE_SCHEMA = {
  type: "object",
  properties: { groups: { type: "array", items: { type: "array", items: { type: "integer" } } } },
  required: ["groups"],
};

// Safety net under the LLM: a merge is only applied if the two seed headlines are also
// semantically close. Gemini can confirm a near-duplicate; it can't fuse unrelated stories.
const MERGE_MIN_COSINE = 0.8;

/**
 * One Gemini Flash pass to merge duplicates the embedding rules missed. Only stories added since the
 * last pass can be merged (one request per ingestion run, and earlier decisions stay stable).
 */
async function mergePass(week: string): Promise<number> {
  const stories = await query<{ id: number; headline: string; reviewed: boolean; variants: string[] | null }>(
    `select s.id, s.headline, s.reviewed,
            (array_agg(a.title order by a.id) filter (where a.title <> s.headline))[1:2] as variants
     from stories s join articles a on a.story_id = s.id
     where s.week_start = $1
     group by s.id order by s.id`,
    [week],
  );
  const fresh = new Set(stories.filter((s) => !s.reviewed).map((s) => Number(s.id)));
  if (fresh.size === 0) return 0;

  const list = stories
    .map((s) => `[${s.id}]${fresh.has(Number(s.id)) ? " NEW" : ""} ${s.headline}${s.variants?.length ? ` || also: ${s.variants.join(" | ")}` : ""}`)
    .join("\n");
  const { groups, _model } = await generateJson<{ groups: number[][] }>({
    system: MERGE_SYSTEM,
    prompt: `${stories.length} story clusters (${fresh.size} NEW):\n\n${list}`,
    schema: MERGE_SCHEMA,
    thinking: "medium",
  });

  const known = new Set(stories.map((s) => Number(s.id)));
  const locked = new Set(
    (await query<{ story_id: number }>("select distinct story_id from issue_items")).map((r) => Number(r.story_id)),
  );
  let merged = 0;
  for (const group of groups) {
    const ids = [...new Set(group.map(Number))].filter((id) => known.has(id) && !locked.has(id)).sort((x, y) => x - y);
    if (ids.length < 2 || !ids.some((id) => fresh.has(id))) continue;
    const [keeper, ...rest] = ids;
    const close = await query<{ id: number }>(
      `select o.id from stories o, stories k
       where k.id = $1 and o.id = any($2::bigint[]) and 1 - (o.embedding <=> k.embedding) >= $3`,
      [keeper, rest, MERGE_MIN_COSINE],
    );
    const others = close.map((r) => Number(r.id));
    if (others.length === 0) continue;
    await query("update articles set story_id = $1 where story_id = any($2::bigint[])", [keeper, others]);
    await query("delete from stories where id = any($1::bigint[])", [others]);
    merged += others.length;
  }
  await query("update stories set reviewed = true where week_start = $1", [week]);
  console.log(`merge pass with ${_model}: ${merged} duplicate stories merged`);
  return merged;
}

/** Throws away this week's story grouping and rebuilds it (used after tuning the rules). */
export async function reclusterWeek(week = weekStart()) {
  await query("update articles set story_id = null where week_start = $1", [week]);
  await query("delete from stories where week_start = $1 and id not in (select story_id from issue_items)", [week]);
  return processWeek({ week });
}

/**
 * Runs screen → embed → cluster until there is nothing left or the time budget runs out
 * (Vercel functions have a hard timeout, so cron calls pass a budget and simply run again).
 */
export async function processWeek({ budgetMs = Infinity, week = weekStart(), cluster = true } = {}) {
  const deadline = Date.now() + budgetMs;
  const done = { screened: 0, embedded: 0, clustered: 0 };
  const timeLeft = () => Date.now() < deadline;

  for (let n; timeLeft() && (n = await screenBatch(week)); ) done.screened += n;
  for (let n; timeLeft() && (n = await embedBatch(week)); ) done.embedded += n;
  for (let n; cluster && timeLeft() && (n = await clusterBatch(week)); ) done.clustered += n;
  const merged = cluster && timeLeft() ? await mergePass(week) : 0;

  const [remaining] = await query<{ unscreened: number; unclustered: number }>(
    `select count(*) filter (where is_relevant is null)::int as unscreened,
            count(*) filter (where is_relevant and story_id is null)::int as unclustered
     from articles where week_start = $1`,
    [week],
  );
  const complete = remaining.unscreened === 0 && remaining.unclustered === 0;
  await logEvent("process", { week, ...done, merged, ...remaining, complete });
  return { week, ...done, merged, ...remaining, complete };
}
