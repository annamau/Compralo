import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./env.js";

// Log facts and usage, never prompts, screenshots, authorization headers or keys.
export function audit(kind: string, fields: Record<string, unknown>) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(resolve(DATA_DIR, "audit.jsonl"), JSON.stringify({ at: new Date().toISOString(), kind, ...fields }) + "\n");
  } catch (error) { console.error("[audit] write failed", error); }
}
