// Pure string helpers (no Node APIs), so they also run in the browser (live commentary checks).

const TRACKING_PARAMS = /^(utm_|mc_|fbclid$|gclid$|ref$|ref_src$|ito$|from$|source$|cmpid$|ocid$|amp$|_ga$)/i;

/** Normalises a URL so the same article shared with different tracking params hashes the same. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    let path = u.pathname.replace(/\/amp\/?$/, "/").replace(/\/+$/, "");
    if (!path) path = "/";
    u.pathname = path;
    u.protocol = "https:";
    return u.toString();
  } catch {
    return raw.trim();
  }
}

export function stripHtml(s: string | undefined | null): string {
  if (!s) return "";
  return s
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#8217;|&rsquo;/g, "'")
    .replace(/&#8216;|&lsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercase, punctuation-free title used for fuzzy duplicate matching. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^a-z0-9₹$%.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Google News titles end in " - Publisher"; strip it when we know the publisher. */
export function stripPublisherSuffix(title: string, publisher?: string): string {
  if (publisher) {
    const suffix = ` - ${publisher}`;
    if (title.endsWith(suffix)) return title.slice(0, -suffix.length).trim();
  }
  return title.trim();
}

/** "YourStory.com" and "YourStory" are the same outlet when counting coverage. */
export function normalizePublisher(publisher: string): string {
  return publisher
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\.(com|in|co\.in|org|net)\/?$/, "")
    .replace(/\s+(tech|startups|companies|business)$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Trigram similarity like Postgres pg_trgm (lowercase words padded with two leading spaces, one trailing). */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const set = new Set<string>();
    for (const w of s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      const padded = `  ${w} `;
      for (let i = 0; i + 3 <= padded.length; i++) set.add(padded.slice(i, i + 3));
    }
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / (ga.size + gb.size - shared);
}
