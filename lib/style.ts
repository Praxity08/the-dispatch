import { readFile } from "node:fs/promises";
import path from "node:path";
import { query } from "./db";

const GUIDE_FILE = path.join(process.cwd(), "shreyas-voice-guide.md");

/** Latest saved style guide (editable from the dashboard); falls back to the guide in the repo. */
export async function getStyleGuide(): Promise<string> {
  const [row] = await query<{ guide: string }>("select guide from style_guide order by updated_at desc, id desc limit 1");
  return row?.guide ?? readFile(GUIDE_FILE, "utf8");
}

export async function saveStyleGuide(guide: string): Promise<void> {
  await query("insert into style_guide (guide) values ($1)", [guide]);
}

/** Loads shreyas-voice-guide.md into the database as the current style guide. */
export async function seedStyleGuide(): Promise<{ saved: number }> {
  const guide = await readFile(GUIDE_FILE, "utf8");
  await saveStyleGuide(guide);
  return { saved: guide.length };
}
