# The Dispatch: design brief for a redesign

Upload this folder to Claude Design and start with this file. It explains what the product is, who uses it, every
screen and what each one must keep doing, so the redesign changes how things look without losing any behaviour.

**What's in this folder**

| Folder / file | What it is |
|---|---|
| `00-DESIGN-BRIEF.md` | This file. Read it first. |
| `screenshots/` | Full-page PNGs of every screen, desktop (1440 px) and mobile (390 px). Real data from 12 Oct 2026. |
| `screens/` | The same 14 screens as standalone HTML files (CSS inlined, no scripts). Open them in a browser, or use them as the starting markup. The dashboard tabs link to each other. |
| `source/` | The current UI code: Next.js 16 + React 19 pages, the client form components and the one stylesheet. |
| `shreyas-voice-guide.md` | Shreya's editorial voice. Use it for tone of UI copy (plain, sceptical, specific, no hype). |
| `editorial-rubric.md` | How stories are scored and chosen. The "How scoring works" tab explains this to Shreya. |

---

## 1. The product

**The Dispatch** is a weekly newsletter about the Indian startup ecosystem, written by **Shreya**. Every Thursday at 8 AM
IST it sends 8–10 stories, each with 2–3 lines of her commentary. An automated engine does the legwork:

1. **Mon–Wed:** reads ~22 news sources (RSS + Google News), merges duplicates into distinct stories.
2. **Mon & Tue 7 PM:** posts an "early look" (top 5 so far) to Telegram so she can 📌 pin or 🚫 block stories.
3. **Wed 2 PM:** Gemini scores every story against a 6-criterion rubric, picks 8–10 across ≥3 topics, and drafts commentary in her voice.
4. **Wed 6 PM:** the draft goes to her on Telegram and the web dashboard. She approves, edits, rewrites, swaps or drops each story.
5. **She confirms** (it never sends on its own). A reminder fires at 10 PM Wednesday if she hasn't.
6. **Thu 8 AM:** it's emailed to subscribers. Bounces and unsubscribes are handled automatically; reader replies come back to the dashboard.

## 2. Who uses what

| Audience | Screens | What they need |
|---|---|---|
| **Shreya (editor)**: the main user | The editor dashboard (8 tabs) + login | Review the week's draft fast, trust the AI's choices (or see why not), stay in control of what's sent. Often on her phone. |
| **Readers** (founders, operators, investors) | Public home page, the newsletter email, unsubscribe page | Subscribe, read a clean email, leave in one click. |

The dashboard is the priority. It's dense and functional today; the redesign should make it feel like a calm, editorial
tool for one person, with the weekly flow (review → confirm → sent) obvious at a glance.

## 3. Screens and what each must keep

Screenshot names match the `screens/` HTML files.

### 01 · Public home (`/`)
- Name, one-line pitch, **subscribe form** (email + Subscribe button, success/error message).
- "This week's pipeline, live": 4 stats (sources watched, articles read, relevant, distinct stories).
- "Most-covered stories this week": table of headline (link), topic, number of outlets.
- Past issues list (appears once issues have been sent) linking to `/issues/{id}`.
- Footer link "Editor login".

### Dashboard shell (all tabs)
- Header: eyebrow "The Dispatch · Editor", greeting "Good to see you, Shreya", **issue strip** (status pill e.g. "In review", issue number, "Confirm before Wed 10 PM", "Sends Thu 8 AM"), Log out.
- **Tabs:** This week's issue · Story pool · Subscribers · Reader replies (with an **unread count badge**) · Voice guide · How scoring works · Past issues · Pipeline.
- Tabs are links (`/admin?tab=…`); the active tab is server-rendered.

### 02 · This week's issue (default tab). The most important screen
- **Progress steps:** Collecting → Drafted → In review → Confirmed → Sending → Sent.
- **Overview stats:** articles read, relevant, distinct stories, scored, active subscribers.
- **Lineup** (8–10 story cards), header shows "N stories · N topics · ⚠ N flagged" and an "Approve all pending" button. Each **story card** has:
  - position number, topic chip, status chip (Pending / Approved), "Edited by you", "⚠ Needs a look" (with the reasons)
  - move up / move down arrows
  - headline (links to source) and "via Publisher"
  - **commentary editor**: textarea with live checks as she types (word count 40–70, sentence count 2–3, banned words, no emojis/exclamation marks, money format), buttons Save & approve (enabled only once the text changes), Discard changes, "Original draft" (restore the AI's first version), and Rewrite with Gemini with an optional instruction ("punchier, lead with the number…")
  - **"Why it was picked · score 94/100"** (collapsible): one-line reason, six criterion bars (score 0–5, weight %, points), outlets that covered it, AI copy-edit review scores
  - actions: **Approve / Unapprove**, **Drop**, **Swap… (N on the bench)**, which opens a panel listing bench stories ranked by score, each with its total, difference vs the current story, six criterion chips (4–5 highlighted), outlet count and a "Swap in" button
- **Removed from this issue:** dropped / swapped-out stories with Restore or **Undo swap**.
- **Bench:** next-best stories (collapsible rows: topic, score, headline, "needs commentary" chip; expanded: source link, reason, commentary editor) plus the **"Add a story from a link"** form (URL + optional headline).
- **Right sidebar:**
  - **Send** panel: readiness checklist (✓ / ○ with a detail line): "Every story approved", "Lineup rules (8–10 stories, 3+ topics, ≤3 per topic, 1 per company)", "Every story has commentary", "Subject line and opening written", **Confirm** (two-step: arm, then confirm, with a summary "9 stories go to N subscribers on Thu 8 AM"), warning if there are no subscribers, "Nothing is emailed until you confirm". After confirming: confirmation time, Send now (only if the slot has passed), Reopen for edits. During/after sending: delivered / queued / bounced / failed counts.
  - **Preview email** (opens the email) and **Send test to me**.
  - **Subject & opening:** editable subject line and intro paragraph.
  - **Timeline:** drafted, sent to Telegram, reminder, confirmed, scheduled send, emailed.
  - **Not happy with this draft?** two-step "Start over" (re-analyse and redraft; warns if she has edits).
- **Empty state** (before Wednesday's draft): "No draft yet", explanation, "Draft this week's issue now", and the add-a-link form.
- **Locked state** (confirmed/sent): cards are read-only, no actions.

### 03 · Story pool
- Every distinct story this week (up to 100), ranked: score, headline + reason, topic, outlet count, action.
- Topic filter chips (All + 13 topics). Notice + "Score new stories" button when some stories are unscored.
- Chips on rows: 📌 Pinned, 🚫 Blocked, Added by you.
- **Before the draft:** each row has 📌 Pin / Unpin and 🚫 Block / Unblock. **After:** "Add to bench", or "In lineup" / "On bench".
- Add-a-link form at the top.

### 04 · Subscribers
- Stats (active / unsubscribed / bounced, each a filter link), explanation of how unsubscribes and bounces work.
- Add subscriber form (email + optional name).
- Table: email (+ name), status (+ last bounce reason), bounce count, joined date, Unsubscribe / Reactivate.
- Today there's only one test subscriber; design for hundreds.

### 05 · Reader replies (screenshot uses 3 sample replies)
- "Mark all read", explanation, stats (unread / in inbox / archived / readers who wrote in), "Check the inbox now".
- Reply cards: sender name + email, received time, "replying to #105", subject, New chip, subscriber status chip; the reply text (newlines kept); actions **Reply** (opens mail), Mark read / Mark unread, Archive / Move to inbox. Unread cards are visually marked.
- Archived view and empty state.

### 06 · Voice guide
- A large editable document (Markdown text) with Save, the guide every AI draft follows.
- **Learning from your edits:** before/after pairs (AI draft struck through vs her version) of her recent edits, which are fed back to the AI. Empty state today.

### 07 · How scoring works (locked) and 08 · unlocked
- Explainer: how a story gets its score, the six criteria (question, why it matters, what 0 / 3 / 5 mean, weight, who scores it), a worked example with this week's lead story, this week's score distribution, how scores become a lineup, how commentary is checked.
- **Rubric editing** behind a second password: locked panel with password field → unlocked editor with weight inputs (live total must be 100%), criterion wording and anchors, selection rules, commentary limits, a note, Save, Restore defaults, version history, Lock.

### 09 · Past issues
- Table of issues: issue (number + subject), status, sent date, delivered, bounced, failed. Only this week's issue exists today.

### 10 · Pipeline
- This week's counts, "Run a step now" buttons (Fetch, Post the early look, Draft, Post draft to Telegram, Send reminder, Check the inbox, Score new stories) each with a hint, Re-analyse from scratch, Sources table (name, type, last fetch, items, error, Pause/Resume), Activity log.

### 11 · Editor login
- Password field, Log in, error message.

### 12 · The newsletter email
- Sent to subscribers. **Email HTML is constrained:** table layout, inline styles, no external CSS/JS, max ~600 px wide, must work in Gmail / Apple Mail / Outlook and dark mode. Content: masthead, issue number and date, intro, numbered stories (topic, headline link, publisher, commentary), sign-off "— Shreya", "just hit reply", unsubscribe + view-in-browser links. Template lives in `source/lib/email.ts` (`renderHtml`).

### 13–14 · Unsubscribe page
- States: confirm ("Unsubscribe from The Dispatch?" + button), done ("You're unsubscribed", masked email, subscribe again), invalid link, test-email link.

### Telegram (not redesignable visually)
Shreya also reviews in Telegram (bot messages with inline buttons: approve, edit, rewrite, swap, drop, confirm; early look with 📌 / 🚫). Only the message wording can change, so it's out of scope here.

## 4. Current visual system (to replace or evolve)

- One stylesheet: `source/app/globals.css` (~1,300 lines, plain CSS, no Tailwind).
- Tokens on `:root`, light + dark (`prefers-color-scheme`): `--bg #fafaf9 / #0c0a09`, `--surface #fff / #1c1917`, `--text #1c1917 / #f5f5f4`, `--muted #78716c / #a8a29e`, `--border #e7e5e4 / #292524`, `--accent #b45309 / #f59e0b` (amber), plus good/warn/bad colours.
- System font stack, 15 px base. Max width 960 px (public) / wider dashboard. Cards, chips, pills, stat tiles, tables.
- Key class names the markup uses: `card`, `chip` (`good`, `warn`), `pill`, `stat`, `stats`, `btn` (`primary`, `secondary`, `ghost`, `danger`), `panel`, `tabs`, `steps`, `checklist`, `swap-panel`, `crit` (`s4`, `s5`), `bars`/`bar-row`, `reply`, `edit-pair`.

## 5. Constraints for the redesign

1. **Keep every feature and state listed in section 3.** Moving, grouping and restyling are welcome; removing isn't.
2. **The page is server-rendered.** Each button is a small `<form>` posting to a server action with hidden fields (e.g. `op=approve`, `item=12`, `issue=1`). Visual changes are free; the form fields and `op` values must stay the same. These are listed in `source/app/admin/forms.tsx` and `actions.ts` ops: `approve, unapprove, drop, restore, approve-all, commentary, rewrite, swap, undo-swap, up, down, add-to-bench, add-link, pin, block, unflag, issue-text, confirm, reopen, redraft, send-now, test-email`.
3. **Mobile matters.** Shreya often reviews on her phone: everything must work at 390 px with a 16 px side gutter and no horizontal scroll.
4. **Light and dark mode** via CSS custom properties.
5. **Plain CSS** (or CSS modules) is easiest to drop back in. If you use Tailwind, say so, since it would need adding.
6. **No external scripts.** Fonts from Google Fonts are fine.
7. **Accessibility:** visible focus states, real buttons and links, labels on inputs, colour isn't the only signal (e.g. approved = chip text + colour).
8. **Tone of copy:** plain and specific, like the voice guide. No exclamation marks, no hype words.

## 6. What to send back

Any of these works (most useful first):
1. **Updated `globals.css`** plus any markup changes to `page.tsx` / `forms.tsx`, keeping the form fields above, so it can be dropped straight in.
2. **HTML/CSS mockups** per screen (like the files in `screens/`), which can be converted into the React components.
3. A **design system page** (tokens, type scale, components: card, chip, button, stat, table, panel, tabs, form fields) plus the key screens.

The newsletter email (screen 12) is a separate, email-safe template. Redesign it as its own HTML file with inline styles.
