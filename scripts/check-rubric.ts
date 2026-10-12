// Sanity test for the commentary checks using the voice guide's own examples: npx tsx scripts/check-rubric.ts
import { checkCommentary } from "../lib/rubric";

const cases = [
  {
    label: "good: Paytm",
    headline: "RBI restricts Paytm Payments Bank from accepting deposits",
    text: "Everyone's framing this as a Paytm story. It's really a message to every fintech that treated a banking licence as a growth hack: compliance is the product now, not the paperwork behind it. Watch how fast the \"bank-in-a-box\" partnerships get re-papered over the next two quarters.",
  },
  {
    label: "good: Zepto",
    headline: "Zepto raises $665 Mn",
    text: "The round size is the headline; the real story is that late-stage investors have stopped worrying about burn. Quick commerce has convinced them it's a distribution business, not a delivery one, and they're paying for the shelf space. The question is whether kiranas or Amazon blink first.",
  },
  {
    label: "bad: Zepto",
    headline: "Zepto raises $665 Mn",
    text: "Zepto has raised a massive $665 million in a game-changing round! This is a testament to the robust quick commerce landscape in India. It remains to be seen how the company will leverage this funding.",
  },
];
for (const c of cases) {
  const r = checkCommentary(c.text, c.headline);
  console.log(`${c.label.padEnd(12)} ${r.failures.length ? "FAIL" : "PASS"}  ${r.sentences} sentences, ${r.words} words, headline-sim ${r.headlineSimilarity}`);
  for (const f of r.failures) console.log(`             - ${f}`);
}
