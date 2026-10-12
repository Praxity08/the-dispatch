/** Public base URL of the app (links in emails, Telegram webhook). */
export function appUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:3000";
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/**
 * The public website as subscribers see it: the logo in emails and the "you subscribed at …" line.
 * Defaults to appUrl(); set PUBLIC_SITE_URL locally so test emails sent from a laptop still load the
 * hosted logo instead of pointing at localhost.
 */
export function publicSiteUrl(): string {
  return (process.env.PUBLIC_SITE_URL ?? appUrl()).replace(/\/+$/, "");
}
