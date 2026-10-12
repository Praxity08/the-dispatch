// Loads the rubric Shreya saved on the dashboard and applies it to the live rubric objects.
import { logEvent, query } from "./db";
import { applyRubric, CRITERION_KEYS, DEFAULT_RUBRIC, type Rubric, snapshotRubric, validateRubric } from "./rubric";

const TTL_MS = 10_000;
let loadedAt = 0;

/** Merges a stored rubric over the defaults, so fields added later always have a value. */
function withDefaults(stored: Partial<Rubric> | null | undefined): Rubric {
  const d = DEFAULT_RUBRIC;
  const criteria = {} as Rubric["criteria"];
  for (const k of CRITERION_KEYS) {
    const c = stored?.criteria?.[k];
    criteria[k] = { ...d.criteria[k], ...c, anchors: { ...d.criteria[k].anchors, ...c?.anchors } };
  }
  return {
    criteria,
    weakSourcingPenalty: stored?.weakSourcingPenalty ?? d.weakSourcingPenalty,
    selection: { ...d.selection, ...stored?.selection },
    commentary: { ...d.commentary, ...stored?.commentary },
  };
}

/** Call at the start of every request / job that scores, selects or checks anything. Cached for a few seconds. */
export async function loadRubric(force = false): Promise<Rubric> {
  if (force || Date.now() - loadedAt > TTL_MS) {
    const [row] = await query<{ rubric: Rubric }>("select rubric from rubric_versions order by id desc limit 1");
    const rubric = withDefaults(row?.rubric);
    // A stored version that somehow fails validation never takes effect.
    applyRubric(validateRubric(rubric).length ? DEFAULT_RUBRIC : rubric);
    loadedAt = Date.now();
  }
  return snapshotRubric();
}

export async function saveRubric(rubric: Rubric, note: string): Promise<string[]> {
  const errors = validateRubric(rubric);
  if (errors.length) return errors;
  const before = await loadRubric(true);
  await query("insert into rubric_versions (rubric, note) values ($1, $2)", [JSON.stringify(rubric), note.trim().slice(0, 200) || null]);
  await loadRubric(true);
  const changedWeights = CRITERION_KEYS.filter((k) => before.criteria[k].weight !== rubric.criteria[k].weight);
  await logEvent("rubric_updated", { note, changedWeights });
  return [];
}

export async function rubricHistory(limit = 8) {
  return query<{ id: number; note: string | null; created_at: string; rubric: Rubric }>(
    "select id, note, created_at, rubric from rubric_versions order by id desc limit $1",
    [limit],
  );
}
