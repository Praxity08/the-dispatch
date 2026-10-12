// Shreya works on IST. Every "week" is keyed by its Monday in IST (YYYY-MM-DD).

const IST_OFFSET_MS = 330 * 60 * 1000;

/** A Date shifted so that its UTC getters read IST wall-clock time. */
function istWallClock(d: Date): Date {
  return new Date(d.getTime() + IST_OFFSET_MS);
}

export function weekStart(d: Date = new Date()): string {
  const ist = istWallClock(d);
  const daysSinceMonday = (ist.getUTCDay() + 6) % 7;
  ist.setUTCDate(ist.getUTCDate() - daysSinceMonday);
  return ist.toISOString().slice(0, 10);
}

/** Thursday 08:00 IST of the given week: when the confirmed newsletter goes out. */
export function sendTimeFor(week: string): Date {
  const d = new Date(`${week}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3);
  return new Date(d.getTime() + 8 * 3600 * 1000 - IST_OFFSET_MS);
}

/** e.g. "Thu 15 Oct, 8:00 AM IST" */
export function formatIst(d: Date): string {
  const s = d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${s.replace(/\bam\b/, "AM").replace(/\bpm\b/, "PM")} IST`;
}

/** Monday of the week `n` weeks before the given week start. */
export function weeksBefore(week: string, n: number): string {
  const d = new Date(`${week}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7 * n);
  return d.toISOString().slice(0, 10);
}
