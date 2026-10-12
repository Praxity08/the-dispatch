// Offline test of rubric validation:  npx tsx scripts/check-rubric-rules.ts
import { DEFAULT_RUBRIC, type Rubric, validateRubric } from "../lib/rubric";

const clone = (): Rubric => JSON.parse(JSON.stringify(DEFAULT_RUBRIC));
const cases: [string, (r: Rubric) => void, boolean][] = [
  ["default rubric is valid", () => {}, true],
  ["weights not adding to 100% are rejected", (r) => (r.criteria.signal.weight = 0.4), false],
  ["impossible lineup (3 topics × 1 per topic < 8 stories) is rejected", (r) => (r.selection.maxPerTopic = 1), false],
  ["min stories above max is rejected", (r) => ((r.selection.min = 11), (r.selection.target = 11)), false],
  ["empty anchor text is rejected", (r) => (r.criteria.india.anchors[3] = " "), false],
  ["min words ≥ max words is rejected", (r) => (r.commentary.minWords = 80), false],
  ["a valid re-weighting is accepted", (r) => ((r.criteria.signal.weight = 0.35), (r.criteria.counterintuitive.weight = 0.15)), true],
];
let failures = 0;
for (const [label, mutate, expectValid] of cases) {
  const r = clone();
  mutate(r);
  const errors = validateRubric(r);
  const ok = (errors.length === 0) === expectValid;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${errors.length ? `  → ${errors[0]}` : ""}`);
}
process.exit(failures ? 1 : 0);
