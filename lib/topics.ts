// Fixed topic taxonomy. Selection must span at least MIN_TOPICS of these.
export const TOPICS = {
  funding_vc: "Funding & VC",
  ipo_markets: "IPOs & Public Markets",
  layoffs_shutdowns: "Layoffs & Shutdowns",
  policy_regulation: "Policy & Regulation",
  fintech: "Fintech",
  commerce_d2c: "Commerce, Quick Commerce & D2C",
  ai_deeptech: "AI & Deeptech",
  mobility_climate: "Mobility, EV & Climate",
  health_edtech: "Healthtech & Edtech",
  saas_enterprise: "SaaS & Enterprise",
  consumer_media: "Consumer Internet & Media",
  ma_consolidation: "M&A & Consolidation",
  people_governance: "People, Leadership & Governance",
  other: "Other",
} as const;

export type Topic = keyof typeof TOPICS;
export const TOPIC_KEYS = Object.keys(TOPICS) as Topic[];
export const MIN_TOPICS = 3;
