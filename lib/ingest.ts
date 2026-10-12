import Parser from "rss-parser";
import { logEvent, query } from "./db";
import { sha256 } from "./hash";
import { canonicalUrl, normalizeTitle, stripHtml, stripPublisherSuffix, truncate } from "./text";
import { weekStart } from "./week";

type Source = { id: number; name: string; kind: "rss" | "google_news" | "gnews"; url: string };

type NewArticle = {
  url: string;
  canonical: string;
  hash: string;
  title: string;
  titleNorm: string;
  publisher: string;
  summary: string;
  publishedAt: string | null;
};

type FeedItem = {
  title?: string;
  link?: string;
  contentSnippet?: string;
  content?: string;
  summary?: string;
  isoDate?: string;
  gnSource?: string | { _: string };
};

const parser: Parser<Record<string, never>, FeedItem> = new Parser({
  timeout: 15_000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; TheDispatchBot/1.0; +https://github.com)" },
  customFields: { item: [["source", "gnSource"]] },
});

const MAX_AGE_DAYS = 8;
const GOOGLE_NEWS_MAX_ITEMS = 40;

function googleNewsUrl(q: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:7d`)}&hl=en-IN&gl=IN&ceid=IN:en`;
}

async function fetchSource(source: Source): Promise<NewArticle[]> {
  if (source.kind === "gnews") return []; // optional GNews API: not configured

  const feedUrl = source.kind === "google_news" ? googleNewsUrl(source.url) : source.url;
  const feed = await parser.parseURL(feedUrl);
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;

  let items = feed.items ?? [];
  if (source.kind === "google_news") {
    items = items
      .sort((a, b) => (b.isoDate ?? "").localeCompare(a.isoDate ?? ""))
      .slice(0, GOOGLE_NEWS_MAX_ITEMS);
  }

  const out: NewArticle[] = [];
  for (const item of items) {
    if (!item.link || !item.title) continue;
    if (item.isoDate && Date.parse(item.isoDate) < cutoff) continue;

    const gnPublisher = typeof item.gnSource === "string" ? item.gnSource : item.gnSource?._;
    const publisher = (gnPublisher ?? source.name).trim();
    const title = stripPublisherSuffix(stripHtml(item.title), gnPublisher);
    // Google News snippets just repeat the headline, so only keep summaries from direct feeds.
    const summary =
      source.kind === "rss" ? truncate(stripHtml(item.contentSnippet ?? item.summary ?? item.content), 800) : "";
    const canonical = canonicalUrl(item.link);

    out.push({
      url: item.link,
      canonical,
      hash: sha256(canonical),
      title,
      titleNorm: normalizeTitle(title),
      publisher,
      summary,
      publishedAt: item.isoDate ?? null,
    });
  }
  return out;
}

async function insertArticles(sourceId: number, week: string, rows: NewArticle[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await query<{ id: number }>(
    `insert into articles (source_id, week_start, url, canonical_url, url_hash, title, title_norm, publisher, summary, published_at)
     select $1, $2::date, * from unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::timestamptz[])
     on conflict (url_hash) do nothing
     returning id`,
    [
      sourceId,
      week,
      rows.map((r) => r.url),
      rows.map((r) => r.canonical),
      rows.map((r) => r.hash),
      rows.map((r) => r.title),
      rows.map((r) => r.titleNorm),
      rows.map((r) => r.publisher),
      rows.map((r) => r.summary),
      rows.map((r) => r.publishedAt),
    ],
  );
  return inserted.length;
}

export type IngestResult = { source: string; fetched: number; inserted: number; error?: string };

/** Pulls every active source and stores new articles. Exact-URL duplicates are dropped here. */
export async function ingestAll(): Promise<{ week: string; results: IngestResult[]; totalInserted: number }> {
  const week = weekStart();
  const sources = await query<Source>("select id, name, kind, url from sources where active order by id");

  const results = await Promise.all(
    sources.map(async (source): Promise<IngestResult> => {
      try {
        const rows = await fetchSource(source);
        // A feed can list the same link twice; dedupe before the insert.
        const unique = [...new Map(rows.map((r) => [r.hash, r])).values()];
        const inserted = await insertArticles(source.id, week, unique);
        await query(
          "update sources set last_fetched_at = now(), last_item_count = $2, last_error = null where id = $1",
          [source.id, unique.length],
        );
        return { source: source.name, fetched: unique.length, inserted };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await query("update sources set last_fetched_at = now(), last_error = $2 where id = $1", [source.id, message]);
        return { source: source.name, fetched: 0, inserted: 0, error: message };
      }
    }),
  );

  const totalInserted = results.reduce((n, r) => n + r.inserted, 0);
  await logEvent("ingest", { week, totalInserted, failed: results.filter((r) => r.error).map((r) => r.source) });
  return { week, results, totalInserted };
}
