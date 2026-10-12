-- Sources verified live on 2026-10-11.
-- Direct RSS where the publisher serves it; Google News RSS (site: filter) where the
-- publisher blocks bots or has no feed; Google News topic queries to catch everything else.

insert into sources (name, kind, url) values
  -- Direct publisher RSS
  ('Inc42',                 'rss', 'https://inc42.com/feed/'),
  ('YourStory',             'rss', 'https://yourstory.com/feed'),
  ('ET Tech',               'rss', 'https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms'),
  ('ET Startups',           'rss', 'https://economictimes.indiatimes.com/tech/startups/rssfeeds/78570550.cms'),
  ('Mint Companies',        'rss', 'https://www.livemint.com/rss/companies'),
  ('MediaNama',             'rss', 'https://www.medianama.com/feed/'),
  ('TechCrunch India',      'rss', 'https://techcrunch.com/tag/india/feed/'),
  ('Rest of World',         'rss', 'https://restofworld.org/feed/latest'),
  ('The Hindu Business',    'rss', 'https://www.thehindu.com/business/feeder/default.rss'),

  -- Publishers reached through Google News (site: filter)
  ('Entrackr',              'google_news', 'startup site:entrackr.com'),
  ('VCCircle',              'google_news', 'startup site:vccircle.com'),
  ('Moneycontrol Startups', 'google_news', 'startup site:moneycontrol.com'),
  ('Business Standard',     'google_news', 'startup site:business-standard.com'),
  ('The Morning Context',   'google_news', 'site:themorningcontext.com'),

  -- Topic queries across all Indian outlets
  ('Funding rounds',        'google_news', 'indian startup funding'),
  ('Layoffs & shutdowns',   'google_news', 'india startup layoffs OR shutdown'),
  ('IPOs & listings',       'google_news', 'india startup IPO'),
  ('Policy & regulation',   'google_news', 'india startup policy OR regulation OR RBI OR SEBI'),
  ('Quick commerce & D2C',  'google_news', 'india quick commerce OR D2C brand'),
  ('Fintech',               'google_news', 'india fintech'),
  ('AI startups',           'google_news', 'india AI startup'),
  ('M&A',                   'google_news', 'india startup acquisition OR acquires')
on conflict (url) do nothing;
