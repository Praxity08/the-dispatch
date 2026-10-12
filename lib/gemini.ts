import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";

// The exam requires Gemini Flash for every AI task. The free tier allows only ~20 requests
// per model per day, and each Flash model has its own quota, so calls fall through this
// chain when a model is out of quota or overloaded. (gemini-2.5-flash is closed to new keys.)
const FLASH_MODELS = (process.env.GEMINI_MODELS ?? "gemini-3.8-flash,gemini-3.6-flash,gemini-3-flash-preview,gemini-3.7-flash")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMS = 768;

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 200_000 } });
  }
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Models that hit their daily quota in this process, with the time they become usable again. */
const exhaustedUntil = new Map<string, number>();

type Failure =
  | { kind: "daily_quota"; retryMs: number }
  | { kind: "rate_limit"; retryMs: number }
  | { kind: "transient" }
  | { kind: "fatal" };

function classify(err: unknown): Failure {
  if (!(err instanceof ApiError)) {
    return /fetch failed|timeout|aborted|ECONNRESET|ETIMEDOUT|empty response/i.test(String(err))
      ? { kind: "transient" }
      : { kind: "fatal" };
  }
  if (err.status === 429) {
    const retrySec = Number(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(err.message)?.[1] ?? 60);
    return /PerDay/i.test(err.message)
      ? { kind: "daily_quota", retryMs: retrySec * 1000 }
      : { kind: "rate_limit", retryMs: retrySec * 1000 };
  }
  return err.status >= 500 ? { kind: "transient" } : { kind: "fatal" };
}

/** Runs `call` against each Flash model in turn until one succeeds. */
async function withFlash<T>(call: (model: string) => Promise<T>): Promise<{ result: T; model: string }> {
  const errors: string[] = [];
  for (const model of FLASH_MODELS) {
    if ((exhaustedUntil.get(model) ?? 0) > Date.now()) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return { result: await call(model), model };
      } catch (err) {
        const failure = classify(err);
        errors.push(`${model}: ${failure.kind} (${err instanceof ApiError ? err.status : String(err).slice(0, 80)})`);
        if (failure.kind === "fatal") throw err;
        if (failure.kind === "daily_quota") {
          exhaustedUntil.set(model, Date.now() + failure.retryMs);
          break;
        }
        if (failure.kind === "rate_limit" && failure.retryMs > 65_000) break;
        if (attempt < 2) await sleep(failure.kind === "rate_limit" ? failure.retryMs + 500 : 3000 * 2 ** attempt);
      }
    }
  }
  throw new Error(`All Gemini Flash models failed or are out of quota:\n${errors.join("\n")}`);
}

const THINKING = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH };

/**
 * Calls Gemini Flash and parses a response constrained to the given JSON schema.
 * Temperature is left at the Gemini 3 default (1.0): lower values make these models loop.
 * Returns the parsed object plus `_model`, the Flash model that answered.
 */
export async function generateJson<T extends object>(opts: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  /** Bulk screening thinks lightly; editorial judgement calls think hard. */
  thinking?: "low" | "medium" | "high";
}): Promise<T & { _model: string }> {
  const { result, model } = await withFlash(async (model) => {
    const res = await ai().models.generateContent({
      model,
      contents: opts.prompt,
      config: {
        systemInstruction: opts.system,
        responseMimeType: "application/json",
        responseJsonSchema: opts.schema,
        thinkingConfig: { thinkingLevel: THINKING[opts.thinking ?? "low"] },
      },
    });
    if (!res.text) throw new Error("Gemini returned an empty response");
    return JSON.parse(res.text) as T;
  });
  return { ...result, _model: model };
}

/** Embeds texts for semantic duplicate detection (up to 100 per request). */
export async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await ai().models.embedContent({
          model: EMBEDDING_MODEL,
          contents: batch,
          config: { outputDimensionality: EMBEDDING_DIMS, taskType: "SEMANTIC_SIMILARITY" },
        });
        for (const e of res.embeddings ?? []) out.push(e.values ?? []);
        break;
      } catch (err) {
        const failure = classify(err);
        if (failure.kind === "fatal" || failure.kind === "daily_quota" || attempt >= 3) throw err;
        await sleep(failure.kind === "rate_limit" ? failure.retryMs + 500 : 3000 * 2 ** attempt);
      }
    }
  }
  return out;
}
