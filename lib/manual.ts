// Shreya adds a story the feeds missed (a tip, a post on X, a piece she read) by pasting its link,
// from Telegram (/add <link>) or the dashboard. It goes through the same dedup and scoring as feed
// articles, then onto the bench with a draft commentary, or is pinned for Wednesday's draft.
import { logEvent, query, toVector } from "./db";
import { loadCovered, rewriteCommentary, scoreStories } from "./draft";
import { addToBench, EDITABLE, type Result } from "./editor";
import { embed } from "./gemini";
import { sha256 } from "./hash";
import { assignStory } from "./process";
import Parser from "rss-parser";
import { canonicalUrl, normalizeTitle, stripHtml, stripPublisherSuffix, trigramSimilarity, truncate } from "./text";
import { weekStart } from "./week";

const PUBLISHERS: Record<string, string> = {
  "inc42.com": "Inc42",
  "yourstory.com": "YourStory",
  "economictimes.indiatimes.com": "The Economic Times",
  "livemint.com": "Mint",
  "entrackr.com": "Entrackr",
  "moneycontrol.com": "Moneycontrol",
  "business-standard.com": "Business Standard",
  "medianama.com": "MediaNama",
  "themorningcontext.com": "The Morning Context",
  "vccircle.com": "VCCircle",
  "techcrunch.com": "TechCrunch",
  "restofworld.org": "Rest of World",
  "thehindu.com": "The Hindu",
  "thehindubusinessline.com": "BusinessLine",
  "reuters.com": "Reuters",
  "bloomberg.com": "Bloomberg",
  "the-ken.com": "The Ken",
  "x.com": "X",
  "twitter.com": "X",
  "linkedin.com": "LinkedIn",
};

export type AddResult = Result & { storyId?: number; itemId?: number };

/** Only public web pages: this fetch runs on our server, so never let it reach internal addresses. */
function parseLink(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^\[|^(127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
    return url;
  } catch {
    return null;
  }
}

function meta(html: string, ...names: string[]): string {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i");
    const tag = re.exec(html)?.[0];
    const content = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (content?.trim()) return stripHtml(content);
  }
  return "";
}

/**
 * Many news sites block server requests (403). Find the headline on Google News instead, searching the
 * words in the link's slug, and accept a result only if it closely matches those words.
 */
async function lookUpHeadline(url: URL): Promise<{ title: string; publisher: string; publishedAt: string | null } | null> {
  const slug = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "")
    .replace(/\.(html?|php|cms)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b(?:[a-z]*\d[a-z\d]*|\d+)$/i, "") // trailing article ids
    .trim();
  if (slug.split(" ").length < 4) return null;
  const host = url.hostname.replace(/^www\./, "");
  const q = encodeURIComponent(`${slug} site:${host}`);
  try {
    const feed = await new Parser<Record<string, never>, { source?: string | { _: string } }>({ timeout: 10_000, customFields: { item: ["source"] } })
      .parseURL(`https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`);
    for (const item of feed.items ?? []) {
      const publisher = typeof item.source === "string" ? item.source : item.source?._;
      const title = stripPublisherSuffix(stripHtml(item.title ?? ""), publisher);
      if (title && trigramSimilarity(normalizeTitle(title), slug.toLowerCase()) >= 0.55) {
        return { title, publisher: publisher ?? PUBLISHERS[host] ?? host, publishedAt: item.isoDate ?? null };
      }
    }
  } catch {
    // Google News unavailable: fall through to asking for the headline.
  }
  return null;
}

/** Reads the page's title, description, publisher and date. Paywalled and JS-only pages may give nothing. */
async function readPage(url: URL): Promise<{ title: string; summary: string; publisher: string; publishedAt: string | null; finalUrl: string }> {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const fallback = { title: "", summary: "", publisher: PUBLISHERS[host] ?? host, publishedAt: null, finalUrl: url.toString() };
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) return fallback;
    const html = (await res.text()).slice(0, 1_500_000);
    const finalHost = new URL(res.url || url.toString()).hostname.toLowerCase().replace(/^www\./, "");
    const title = meta(html, "og:title", "twitter:title") || stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
    const published = meta(html, "article:published_time", "og:published_time", "publish-date", "date");
    return {
      title: title.replace(/\s+[|\-–—]\s+[^|\-–—]{2,40}$/, "").trim(), // drop " | Inc42"-style suffixes
      summary: truncate(meta(html, "og:description", "description", "twitter:description"), 800),
      publisher: meta(html, "og:site_name") || PUBLISHERS[finalHost] || fallback.publisher,
      publishedAt: published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : null,
      finalUrl: res.url || url.toString(),
    };
  } catch {
    return fallback;
  }
}

/**
 * Adds the story at `rawUrl` to this week. `headline` is only needed when the page can't be read
 * (paywalls, X posts). Uses up to 3 Gemini requests: embed, score, and a draft commentary.
 */
export async function addStoryFromLink(rawUrl: string, headline?: string): Promise<AddResult> {
  const url = parseLink(rawUrl);
  if (!url) return { ok: false, message: "That doesn't look like a public web link." };
  const week = weekStart();
  const hash = sha256(canonicalUrl(url.toString()));

  // Already collected? Reuse it rather than creating a duplicate.
  const [existing] = await query<{ id: number; story_id: number | null; week_start: string; title: string; embedding: string | null }>(
    "select id, story_id, week_start::text, title, embedding::text from articles where url_hash = $1",
    [hash],
  );
  if (existing && existing.week_start !== week) {
    return { ok: false, message: `That link was already collected in the week of ${existing.week_start}, so it can't run as new this week.` };
  }

  let storyId: number;
  if (existing?.story_id) {
    storyId = Number(existing.story_id);
    await query("update articles set added_by_shreya = true where id = $1", [existing.id]);
  } else {
    let article = existing;
    if (!article) {
      const page = await readPage(url);
      if (!page.title && !headline?.trim()) {
        const found = await lookUpHeadline(url);
        if (found) Object.assign(page, { title: found.title, publisher: page.publisher === url.hostname.replace(/^www\./, "") ? found.publisher : page.publisher, publishedAt: found.publishedAt });
      }
      const title = headline?.trim() || page.title;
      if (!title) return { ok: false, message: "I couldn't read a headline from that page (paywalled or app-only). Add it again with a headline after the link." };
      const canonical = canonicalUrl(page.finalUrl);
      const [row] = await query<{ id: number; story_id: number | null; week_start: string; title: string; embedding: string | null }>(
        `insert into articles (source_id, week_start, url, canonical_url, url_hash, title, title_norm, publisher, summary, published_at, is_relevant, topic, added_by_shreya)
         values (null, $1, $2, $3, $4, $5, $6, $7, $8, $9, true, 'other', true)
         on conflict (url_hash) do update set added_by_shreya = true
         returning id, story_id, week_start::text, title, embedding::text`,
        [week, url.toString(), canonical, hash, truncate(title, 300), normalizeTitle(title), page.publisher, page.summary, page.publishedAt ?? new Date().toISOString()],
      );
      article = row;
    } else {
      // Collected but screened out (or not processed yet): her call overrides the relevance screen.
      await query("update articles set is_relevant = true, added_by_shreya = true where id = $1", [article.id]);
    }
    let embedding = article.embedding;
    if (!embedding) {
      embedding = toVector((await embed([article.title]))[0]);
      await query("update articles set embedding = $2::vector where id = $1", [article.id, embedding]);
    }
    storyId = await assignStory({ id: Number(article.id), title: article.title, title_norm: normalizeTitle(article.title), embedding }, week);
  }

  const [story] = await query<{ headline: string }>("select headline from stories where id = $1", [storyId]);
  const covered = (await loadCovered(week)).some((c) => c.id === storyId);
  if (covered) {
    await logEvent("story_added_from_link", { url: url.toString(), story: storyId, covered: true });
    return { ok: false, storyId, message: `That's the same story as “${truncate(story.headline, 90)}”, which ran in one of the last 4 issues.` };
  }

  let scoreNote = "";
  try {
    const [scored] = await scoreStories([storyId], week);
    if (scored?.scored) scoreNote = ` It scores ${Math.round(scored.score)}/100.`;
  } catch {
    scoreNote = " Gemini is busy, so it isn't scored yet (it will be with the next scoring run).";
  }

  // Before the draft: pin it so Wednesday's selection must include it. After: straight onto the bench.
  const [issue] = await query<{ id: number; status: string }>("select id, status from issues where week_start = $1", [week]);
  if (!issue || issue.status === "collecting") {
    await query("update stories set editor_flag = 'pin' where id = $1", [storyId]);
    await logEvent("story_added_from_link", { url: url.toString(), story: storyId, pinned: true });
    return { ok: true, storyId, message: `Added “${truncate(story.headline, 90)}” and pinned it for Wednesday's draft.${scoreNote}` };
  }
  if (!EDITABLE.includes(issue.status)) {
    await logEvent("story_added_from_link", { url: url.toString(), story: storyId });
    return { ok: true, storyId, message: `Added “${truncate(story.headline, 90)}” to this week's pool, but the issue is ${issue.status}. Reopen it to swap the story in.${scoreNote}` };
  }

  const bench = await addToBench(issue.id, storyId);
  const [item] = await query<{ id: number; role: string; commentary: string | null }>(
    "select id, role, commentary from issue_items where issue_id = $1 and story_id = $2",
    [issue.id, storyId],
  );
  if (!bench.ok && item) {
    return { ok: true, storyId, itemId: Number(item.id), message: `That's already in this issue (${item.role === "selected" ? "in the lineup" : "on the bench"}) as “${truncate(story.headline, 90)}”.` };
  }
  if (!item) return { ok: false, storyId, message: bench.message };

  let draftNote = " Write its commentary, then swap it in.";
  try {
    await rewriteCommentary(Number(item.id));
    draftNote = " Gemini drafted its commentary; check it, then swap it in.";
  } catch {
    draftNote = " Gemini is busy, so write its commentary yourself, then swap it in.";
  }
  await logEvent("story_added_from_link", { url: url.toString(), story: storyId, item: item.id }, issue.id);
  return { ok: true, storyId, itemId: Number(item.id), message: `Added “${truncate(story.headline, 90)}” to the bench.${scoreNote}${draftNote}` };
}
