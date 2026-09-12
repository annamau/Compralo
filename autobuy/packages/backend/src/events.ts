// Append-only event log + SSE fan-out. Every event is also printed as one terminal line,
// so the story is visible while Chrome is closed.
import type { Event, EventType } from "../../shared/types.js";
import { persist, state } from "./state.js";

type Subscriber = (e: Event) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}
export const subscriberCount = () => subscribers.size;

export function emit(instruction_id: string, type: EventType, detail: string, data?: unknown): Event {
  const e: Event = { at: new Date().toISOString(), instruction_id, type, detail, ...(data !== undefined ? { data } : {}) };
  state.events.push(e);
  persist();
  console.log(`[${e.at.slice(11, 19)}] ${type.padEnd(24)} ${instruction_id.slice(0, 8)}  ${detail}`);
  for (const fn of subscribers) { try { fn(e); } catch { /* a dead stream must not break the agent */ } }
  return e;
}

export const eventsFor = (instruction_id: string) => state.events.filter((e) => e.instruction_id === instruction_id);
