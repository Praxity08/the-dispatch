# Editorial Rubric — The Dispatch

How the system grades and selects stories every Wednesday, and how it checks the commentary it drafts.
The constants live in [`lib/rubric.ts`](lib/rubric.ts); the voice rules come from [`shreyas-voice-guide.md`](shreyas-voice-guide.md).

---

## A. Story scoring (weighted total out of 100)

Each criterion is scored 0–5 (1, 2 and 4 sit between the anchors below). A criterion's points are
`weight × score ÷ 5`, so a 5/5 on Signal is worth 30 points and a 3/5 is worth 18. The six add up to a total out of 100.
Gemini is told to be a demanding editor: most stories land at 1–3, and 5 is reserved for the exceptional.

The criteria, questions and anchors live in `CRITERIA` in [`lib/rubric.ts`](lib/rubric.ts). The Gemini scoring prompt
and the dashboard's "How scoring works" tab are both generated from it, so they always match this table.

| # | Criterion | Weight | The question | 0 | 3 | 5 | Scored by |
|---|---|---|---|---|---|---|---|
| 1 | **Signal** | 30% | Does this change where money, regulation, talent or users are actually moving? | PR, a routine update or a minor announcement | A notable move for one company | A sector-level shift, a precedent or an inflection point | Gemini Flash |
| 2 | **Counterintuitive** | 20% | Does it cut against what most people in the ecosystem currently believe? | Confirms the obvious | Adds a twist to the usual narrative | Flips a common belief, with evidence | Gemini Flash |
| 3 | **Under-reported** | 15% | How many different outlets covered it this week? | 10+ outlets | 3 outlets | 1 outlet | Code (distinct outlets in the story cluster) |
| 4 | **Connects trends** | 15% | Does it link to another story this week, or to a trend nobody has put side by side with it? | Stands alone | Fits a known trend | Links to another story this week nobody has paired it with | Gemini Flash (must name the linked story) |
| 5 | **India relevance** | 10% | How directly does it affect Indian founders, investors or users? | Barely touches India | Affects one Indian segment | Directly changes things for Indian founders, investors or users | Gemini Flash |
| 6 | **Commentary potential** | 10% | Is there a sharp, specific take to write in two or three lines? | Nothing to add beyond the headline | A decent angle exists | Concrete numbers and names, and a sharp take is obvious | Gemini Flash |

**Worked example (week of 12 Oct 2026, lead story):** "India's semiconductor ambition is all packaging, no chips"
scored Signal 4, Counterintuitive 5, Under-reported 5 (1 outlet), Connects 5, India 5, Commentary potential 5
→ 24 + 20 + 15 + 15 + 10 + 10 = **94/100**.

Under-reported mapping: 1 outlet → 5 · 2 → 4 · 3 → 3 · 4–5 → 2 · 6–9 → 1 · 10+ → 0.

**Adjustments**
- **−10 weak sourcing:** every article in the story is from an outlet outside the recognised list (ET, Mint, Inc42, YourStory, Entrackr, Moneycontrol, Business Standard, MediaNama, The Morning Context, VCCircle, TechCrunch, Rest of World, The Hindu / BusinessLine, Reuters, Bloomberg, Financial Express, CNBC-TV18, NDTV Profit, Business Today, Forbes India, Fortune India, Indian Express, Hindustan Times, Times of India, and others).
- **Excluded:** the story (or a follow-up with no new development) appeared in any of the last 4 newsletters.

Every story also gets a one-line reason, which Shreya sees in Telegram.

---

## B. Selection rules (enforced in code)

| Rule | Limit |
|---|---|
| Story count | 8–10 (target 9) |
| Topic spread | at least 3 distinct topics |
| Topic cap | at most 3 stories from one topic |
| Repeats | nothing covered in the last 4 newsletters |
| Company cap | at most 1 story per company |
| Bench | next 10 best stories that also pass the rules (Shreya's swap options) |
| Shreya's pins | stories she 📌 pinned (early look, story pool, or added from a link) must be in the pick |
| Shreya's blocks | stories she 🚫 blocked are never shortlisted or benched |

**Process**
1. Gemini scores every story this week (batched).
2. Code ranks them and shortlists the top 25 (pinned stories are always on the shortlist; blocked ones never are).
3. Gemini picks the final 8–10, balancing score, variety and connections, and orders them (lead story first).
4. Code validates every rule. On failure Gemini gets the exact errors and repairs its pick (up to 2 tries); if it still fails, code selects greedily by score while enforcing the rules.

---

## C. Commentary quality

**Automatic checks (code, pass/fail)**

| Check | Rule |
|---|---|
| Length | 2–3 sentences, 40–70 words |
| No headline restating | first sentence's trigram similarity to the headline < 0.5 |
| Banned words | none from the voice guide's banned list |
| Formatting | no emojis, exclamation marks or hashtags; money as ₹ Cr / $ Mn |

**Gemini self-review (1–5 each; average must be ≥ 4)**

| Criterion | Checks |
|---|---|
| Angle | says something non-obvious, beyond a summary |
| Voice match | plain-spoken, sceptical, specific, per the voice guide |
| Grounded | every fact is in the source articles; no invented numbers |
| Forwardable | would a founder forward this line to their co-founder? |

Drafts and rewrites also see Shreya's most recent hand edits (the AI's version next to hers) as examples, so the voice keeps moving toward hers.

Anything that fails is rewritten once. If it still fails, it's flagged ⚠️ in Telegram for Shreya to edit by hand.

---

**Budget:** roughly 6–10 Gemini Flash requests for the whole Wednesday run, within the free tier.
