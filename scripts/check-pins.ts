// Offline test of Shreya's pins in selection:  npx tsx scripts/check-pins.ts
import { greedySelect, validateSelection } from "../lib/draft";

type C = Parameters<typeof validateSelection>[1] extends Map<number, infer T> ? T : never;
const topics = ["funding", "policy", "ai", "fintech", "commerce"];
// 20 stories, best first; 5 topics, distinct companies.
const ranked = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1, headline: `Story ${i + 1}`, topic: topics[i % 5], company: `Co${i + 1}`, score: 100 - i, criteria: {}, flag: null,
})) as unknown as C[];
const byId = new Map(ranked.map((c) => [c.id, c]));

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` → ${detail}` : ""}`);
};

const top9 = ranked.slice(0, 9).map((c) => c.id);
check("valid pick without pins", validateSelection(top9, byId, new Set()).length === 0);
const errs = validateSelection(top9, byId, new Set(), new Set([18]));
check("missing pin is a rule error", errs.some((e) => e.includes("pinned") && e.includes("18")), errs.join("; "));
check("pick with the pin passes", validateSelection([...top9.slice(0, 8), 18], byId, new Set(), new Set([18])).length === 0);

const greedy = greedySelect(ranked, new Set([17, 20]));
check("greedy fallback keeps low-scoring pins", greedy.includes(17) && greedy.includes(20), JSON.stringify(greedy));
check("greedy pick obeys every rule", validateSelection(greedy, byId, new Set(), new Set([17, 20])).length === 0, validateSelection(greedy, byId, new Set(), new Set([17, 20])).join("; "));

// Pins all in one topic: the topic-spread repair must not swap a pin out.
const sameTopic = ranked.map((c) => (c.id <= 3 ? c : { ...c })) as C[];
const pinned = new Set([1, 6, 11]); // ids 1, 6, 11 all have topic "funding"
const g2 = greedySelect(sameTopic, pinned);
check("topic repair never drops a pin", [...pinned].every((id) => g2.includes(id)), JSON.stringify(g2));
process.exit(failures ? 1 : 0);
