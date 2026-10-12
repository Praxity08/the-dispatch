import { query } from "@/lib/db";
import { TOPICS, type Topic } from "@/lib/topics";
import { formatIst, weekStart } from "@/lib/week";
import { SubscribeForm } from "./subscribe-form";
import { ThemeToggle } from "./theme-toggle";

export const dynamic = "force-dynamic";

type Totals = { articles: number; relevant: number; stories: number; sources: number; subscribers: number };
type StoryRow = { id: number; headline: string; topic: Topic | null; articles: number; outlets: number; url: string };
type Archive = { id: number; issue_number: number; subject: string; sent_at: string };

export default async function Home() {
  const week = weekStart();
  const [totals] = await query<Totals>(
    `select (select count(*)::int from articles where week_start = $1) as articles,
            (select count(*)::int from articles where week_start = $1 and is_relevant) as relevant,
            (select count(*)::int from stories where week_start = $1) as stories,
            (select count(*)::int from sources where active) as sources,
            (select count(*)::int from subscribers where status = 'active') as subscribers`,
    [week],
  );
  const stories = await query<StoryRow>(
    `select s.id, s.headline, coalesce(s.topic, mode() within group (order by a.topic)) as topic,
            count(*)::int as articles, count(distinct lower(a.publisher))::int as outlets,
            (array_agg(a.url order by (a.url like 'https://news.google.com/%'), a.id))[1] as url
     from stories s join articles a on a.story_id = s.id
     where s.week_start = $1
     group by s.id order by count(*) desc, s.id limit 12`,
    [week],
  );
  const archive = await query<Archive>(
    "select id, issue_number, subject, sent_at from issues where status = 'sent' order by sent_at desc limit 10",
  );

  return (
    <main>
      <nav className="site-head" aria-label="Site">
        <a href="/" className="site-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/dispatch-logo.png" alt="The Dispatch — India's startup brief" />
        </a>
        <div className="site-actions">
          <ThemeToggle />
          <a href="/admin" className="btn primary">Editor login</a>
        </div>
      </nav>

      <header className="hero">
        <p className="eyebrow">Every Thursday morning</p>
        <h1 className="display">The Dispatch</h1>
        <p className="lede">
          Eight to ten stories from the Indian startup ecosystem that are counterintuitive, under-reported, or connect two trends nobody else has
          linked, each with Shreya&apos;s take in two or three lines.
        </p>
        <SubscribeForm />
      </header>

      <section>
        <h2>This week&apos;s pipeline, live</h2>
        <p className="muted small">An automated engine reads the sources Monday to Wednesday; Shreya makes every final call.</p>
        <div className="stats">
          <div className="stat"><b>{totals.sources}</b><span className="muted">sources watched</span></div>
          <div className="stat"><b>{totals.articles}</b><span className="muted">articles read</span></div>
          <div className="stat"><b>{totals.relevant}</b><span className="muted">relevant</span></div>
          <div className="stat"><b>{totals.stories}</b><span className="muted">distinct stories</span></div>
        </div>
      </section>

      <section>
        <h2>Most-covered stories this week</h2>
        <p className="muted small">What everyone is writing about. The Dispatch often picks what they aren&apos;t.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Story</th><th>Topic</th><th>Outlets</th></tr></thead>
            <tbody>
              {stories.map((s) => (
                <tr key={s.id}>
                  <td><a href={s.url} target="_blank" rel="noreferrer">{s.headline}</a></td>
                  <td>{s.topic ? TOPICS[s.topic] : "—"}</td>
                  <td>{s.outlets}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {archive.length > 0 && (
        <section>
          <h2>Past issues</h2>
          <ul className="archive">
            {archive.map((a) => (
              <li key={a.id}><a href={`/issues/${a.id}`}>{a.subject}</a> <span className="muted small">{formatIst(new Date(a.sent_at))}</span></li>
            ))}
          </ul>
        </section>
      )}

      <footer className="muted small">
        The Dispatch · every Thursday morning · <a href="/admin">Editor login</a>
      </footer>
    </main>
  );
}
