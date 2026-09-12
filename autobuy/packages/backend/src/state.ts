// In-memory state, mirrored to ./data/state.json on every change. No database.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./env.js";
import type { Event, Instruction, InstructionStatus } from "../../shared/types.js";

export type UsageBucket = { calls: number; input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number; usd: number };
export type Usage = { understand: UsageBucket; normalise: UsageBucket; extract: UsageBucket };
const bucket = (): UsageBucket => ({ calls: 0, input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, usd: 0 });

type Persisted = { instructions: Instruction[]; events: Event[]; seen: Record<string, string[]>; usage: Usage; saved_at: string };

export const state = {
  instructions: new Map<string, Instruction>(),
  events: [] as Event[],
  seen: new Map<string, Set<string>>(),
  usage: { understand: bucket(), normalise: bucket(), extract: bucket() } as Usage,
};

export const STATE_FILE = resolve(DATA_DIR, "state.json");

export function persist() {
  mkdirSync(DATA_DIR, { recursive: true });
  const out: Persisted = {
    instructions: [...state.instructions.values()],
    events: state.events,
    seen: Object.fromEntries([...state.seen].map(([k, v]) => [k, [...v]])),
    usage: state.usage,
    saved_at: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(out, null, 2));
}

export function load() {
  if (!existsSync(STATE_FILE)) return;
  try {
    const p = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Persisted;
    for (const i of p.instructions ?? []) {
      // Killed mid-execution: nothing is captured before merchant checkout, so it is safe to resume monitoring.
      if (i.status === "EXECUTING" || i.status === "EVALUATING") i.status = "ACTIVE";
      state.instructions.set(i.id, i);
    }
    state.events = p.events ?? [];
    for (const [k, v] of Object.entries(p.seen ?? {})) state.seen.set(k, new Set(v));
    if (p.usage) state.usage = { understand: { ...bucket(), ...p.usage.understand }, normalise: { ...bucket(), ...p.usage.normalise }, extract: { ...bucket(), ...p.usage.extract } };
    console.log(`[state] loaded ${state.instructions.size} instruction(s), ${state.events.length} event(s) from ${STATE_FILE}`);
  } catch (e) {
    console.error(`[state] could not load ${STATE_FILE}:`, e);
  }
}

export function reset() {
  state.instructions.clear();
  state.events = [];
  state.seen.clear();
  state.usage = { understand: bucket(), normalise: bucket(), extract: bucket() };
  persist();
}

export function seenSet(instructionId: string): Set<string> {
  let s = state.seen.get(instructionId);
  if (!s) { s = new Set(); state.seen.set(instructionId, s); }
  return s;
}

export function setStatus(i: Instruction, status: InstructionStatus) {
  i.status = status;
  persist();
}

export function recordUsage(kind: keyof Usage, u: { input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number; usd: number }) {
  const b = state.usage[kind];
  b.calls += 1; b.input_tokens += u.input_tokens; b.output_tokens += u.output_tokens;
  b.cache_write_tokens += u.cache_write_tokens; b.cache_read_tokens += u.cache_read_tokens; b.usd += u.usd;
  persist();
}
