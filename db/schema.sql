-- The Dispatch: Newsletter Intelligence Engine
-- Postgres (Neon) schema. Weeks are keyed by the Monday (IST) they start on.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- Where articles come from: RSS feeds, Google News RSS queries, GNews API queries.
create table if not exists sources (
  id              serial primary key,
  name            text not null,
  kind            text not null check (kind in ('rss', 'google_news', 'gnews')),
  url             text not null unique,          -- feed URL, or the search query for API kinds
  active          boolean not null default true,
  last_fetched_at timestamptz,
  last_item_count int,
  last_error      text,
  created_at      timestamptz not null default now()
);

-- A "story" is one real-world event. Several articles (Inc42 + ET + YourStory
-- covering the same funding round) collapse into one story.
create table if not exists stories (
  id          bigserial primary key,
  week_start  date not null,
  headline    text not null,
  embedding   vector(768),
  reviewed    boolean not null default false,       -- seen by the Gemini merge pass
  topic       text,
  company     text,                                  -- primary company/organisation (one-per-company rule)
  scores      jsonb,                                 -- rubric criteria (0-5) + reason, see editorial-rubric.md
  score       numeric,                               -- weighted total out of 100
  scored_at   timestamptz,
  editor_flag text check (editor_flag in ('pin', 'block')), -- Shreya's early-look call: must include / keep out
  created_at  timestamptz not null default now()
);
create index if not exists stories_week_idx on stories (week_start);

create table if not exists articles (
  id            bigserial primary key,
  source_id     int references sources(id) on delete set null,
  story_id      bigint references stories(id) on delete set null,
  url           text not null,
  canonical_url text not null,
  url_hash      text not null unique,             -- sha256 of canonical_url: exact-dup guard
  title         text not null,
  title_norm    text not null,                     -- lowercased, punctuation-stripped: fuzzy-dup guard
  publisher     text,
  summary       text,
  published_at  timestamptz,
  fetched_at    timestamptz not null default now(),
  week_start    date not null,
  embedding     vector(768),                       -- semantic-dup guard
  is_relevant   boolean,                           -- null = not yet screened
  topic         text,
  scores        jsonb,                             -- Gemini editorial scores + reasoning
  scored_at     timestamptz,
  added_by_shreya boolean not null default false   -- pasted in as a link, not found by a feed
);
create index if not exists articles_week_idx on articles (week_start);
create index if not exists articles_title_trgm_idx on articles using gin (title_norm gin_trgm_ops);
create index if not exists articles_story_idx on articles (story_id);

-- Shreya's documented editorial voice (latest row wins).
create table if not exists style_guide (
  id          serial primary key,
  guide       text not null,
  examples    jsonb not null default '[]',         -- past [{story, commentary}] few-shot samples
  updated_at  timestamptz not null default now()
);

-- One newsletter per week. The status machine is the "never send autonomously" gate.
create table if not exists issues (
  id               serial primary key,
  week_start       date not null unique,
  issue_number     int,
  status           text not null default 'collecting'
                   check (status in ('collecting', 'drafted', 'in_review', 'confirmed', 'sending', 'sent', 'failed')),
  subject          text,
  intro            text,
  html             text,
  drafted_at       timestamptz,
  delivered_at     timestamptz,                    -- draft pushed to Telegram
  reminder_sent_at timestamptz,
  confirmed_at     timestamptz,
  confirmed_by     bigint,                         -- Telegram user id that confirmed
  sent_at          timestamptz,
  selection_log    jsonb,                          -- rule checks / repair attempts from selection
  telegram_header_message_id  bigint,
  telegram_control_message_id bigint,              -- the "Confirm" message, updated with progress
  redeliver        boolean not null default false, -- re-post to Telegram once a redraft finishes
  created_at       timestamptz not null default now()
);

-- Stories in an issue. 'selected' = in the draft, 'bench' = swap candidates.
create table if not exists issue_items (
  id                   bigserial primary key,
  issue_id             int not null references issues(id) on delete cascade,
  story_id             bigint not null references stories(id),
  article_id           bigint not null references articles(id),
  role                 text not null check (role in ('selected', 'bench')),
  position             int,
  status               text not null default 'pending'
                       check (status in ('pending', 'approved', 'dropped', 'swapped_out')),
  topic                text,
  reason               text,                        -- why Gemini picked it
  commentary           text,
  original_commentary  text,
  telegram_message_id  bigint,
  score                numeric,
  checks               jsonb,                       -- commentary quality checks (rubric part C)
  flagged              boolean not null default false,
  edited_by_shreya     boolean not null default false,
  swapped_for          bigint references issue_items(id), -- bench item that replaced this one
  updated_at           timestamptz not null default now(),
  unique (issue_id, story_id)
);

create table if not exists subscribers (
  id                 serial primary key,
  email              text not null unique,         -- stored lowercased
  name               text,
  status             text not null default 'active'
                     check (status in ('active', 'unsubscribed', 'bounced')),
  bounce_count       int not null default 0,
  last_bounce_at     timestamptz,
  last_bounce_reason text,
  subscribed_at      timestamptz not null default now(),
  unsubscribed_at    timestamptz
);

-- One row per (issue, subscriber): makes sending idempotent and resumable.
create table if not exists deliveries (
  id            bigserial primary key,
  issue_id      int not null references issues(id) on delete cascade,
  subscriber_id int not null references subscribers(id) on delete cascade,
  status        text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'bounced')),
  message_id    text,
  error         text,
  sent_at       timestamptz,
  unique (issue_id, subscriber_id)
);

-- Audit trail for every pipeline step and every human action.
create table if not exists events (
  id          bigserial primary key,
  kind        text not null,
  issue_id    int references issues(id) on delete set null,
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists events_created_idx on events (created_at desc);

-- Inbound Gmail messages already handled (bounce notices, "unsubscribe" replies), so none is counted twice.
create table if not exists processed_mail (
  message_id   text primary key,
  kind         text not null,                      -- 'hard_bounce' | 'soft_bounce' | 'unsubscribe' | 'ignored'
  email        text,
  detail       text,
  processed_at timestamptz not null default now()
);

-- Editable scoring rubric (latest row wins; older rows are the version history). Empty = built-in defaults.
create table if not exists rubric_versions (
  id         serial primary key,
  rubric     jsonb not null,                       -- see Rubric in lib/rubric.ts
  note       text,
  created_at timestamptz not null default now()
);

-- Replies from readers to the newsletter, read from the Gmail inbox (shown on the dashboard's Replies tab).
create table if not exists reader_replies (
  id            bigserial primary key,
  message_id    text not null unique,
  from_email    text not null,
  from_name     text,
  subscriber_id int references subscribers(id) on delete set null,
  issue_id      int references issues(id) on delete set null,  -- the issue they replied to, when known
  subject       text,
  body          text not null,                   -- their words, with the quoted newsletter stripped
  received_at   timestamptz not null,
  status        text not null default 'new' check (status in ('new', 'read', 'archived')),
  created_at    timestamptz not null default now()
);
create index if not exists reader_replies_received_idx on reader_replies (received_at desc);

-- Upgrades for databases created before these columns existed.
alter table stories  add column if not exists editor_flag text check (editor_flag in ('pin', 'block'));
alter table articles add column if not exists added_by_shreya boolean not null default false;
alter table issues   add column if not exists redeliver boolean not null default false;
alter table issues   add column if not exists ranked_rubric jsonb;      -- the rubric the current lineup was picked with
alter table issues   add column if not exists ranked_at timestamptz;
-- Demo data: sample subscribers and replies are labelled on the dashboard and never emailed or counted for sending.
alter table subscribers    add column if not exists is_sample boolean not null default false;
alter table reader_replies add column if not exists is_sample boolean not null default false;
