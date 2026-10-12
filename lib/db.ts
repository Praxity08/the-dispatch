import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let client: NeonQueryFunction<false, false> | null = null;

/** Lazily-created Neon HTTP client (avoids failing at build time when env is absent). */
export function db(): NeonQueryFunction<false, false> {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    client = neon(url);
  }
  return client;
}

/** Parameterised query with a plain SQL string ($1, $2, ...). */
export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(text, params)) as T[];
}

/** pgvector literal, e.g. '[0.1,0.2]'. */
export function toVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

export async function logEvent(kind: string, payload: Record<string, unknown> = {}, issueId?: number) {
  await query("insert into events (kind, issue_id, payload) values ($1, $2, $3)", [kind, issueId ?? null, JSON.stringify(payload)]);
}
