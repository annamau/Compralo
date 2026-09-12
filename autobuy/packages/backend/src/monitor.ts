// The monitor: every 3 s, GET /offers; for each ACTIVE instruction × each in-stock offer not yet
// seen for that instruction: normalise (cached) → evaluate → emit → execute if qualified.
// The executor is awaited, so two qualifying offers in one tick cannot race.
import type { Instruction, NormalisedOffer, RawOffer } from "../../shared/types.js";
import { MARKET_URL, POLL_INTERVAL_MS } from "./env.js";
import { persist, seenSet, state } from "./state.js";
import { fetchOffers } from "./market.js";
import { describeProduct, normaliseOffer } from "./ai.js";
import { evaluate } from "./rules.js";
import { execute } from "./executor.js";
import { emit } from "./events.js";
import { money, round2, summary } from "./util.js";

let ticking = false;
let ticks = 0;
let lastError = "";
const normaliseAttempts = new Map<string, number>(); // `${instruction}|${offer}` → attempts so far

export function startMonitor() {
  console.log(`[monitor] polling ${MARKET_URL}/offers every ${POLL_INTERVAL_MS / 1000}s`);
  setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
}

export async function tick() {
  if (ticking) return; // a normalise call or an execution is still in flight
  ticking = true;
  try {
    let offers: RawOffer[];
    try {
      offers = await fetchOffers();
      if (lastError) { console.log("[monitor] market reachable again"); lastError = ""; }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== lastError) console.error(`[monitor] ${msg} — is the market simulator on :4000?`);
      lastError = msg;
      return;
    }
    ticks += 1;
    const active = [...state.instructions.values()].filter((i) => i.status === "ACTIVE");
    if (ticks % 10 === 1) console.log(`[monitor] tick ${ticks}: ${offers.length} listing(s), ${offers.filter((o) => o.in_stock).length} in stock, ${active.length} ACTIVE instruction(s)`);
    for (const instruction of active) {
      const seen = seenSet(instruction.id);
      for (const raw of offers) {
        if (instruction.status !== "ACTIVE") break; // purchased or failed earlier in this tick
        if (!raw.in_stock || seen.has(raw.id)) continue;
        seen.add(raw.id);
        persist();
        await consider(instruction, raw);
      }
    }
  } finally {
    ticking = false;
  }
}

async function consider(instruction: Instruction, raw: RawOffer) {
  const id = instruction.id;
  const total = round2(raw.price + raw.shipping);
  emit(id, "OFFER_SEEN", `${raw.retailer}: "${raw.listing_title}" ${money(raw.price)} + ${money(raw.shipping)} shipping = ${money(total)} ${raw.currency}, ${raw.condition}`, { offer: raw });

  const n = await normaliseOffer(raw, instruction.product);
  if ("error" in n) {
    const key = `${id}|${raw.id}`;
    const attempts = (normaliseAttempts.get(key) ?? 0) + 1;
    normaliseAttempts.set(key, attempts);
    if (attempts < 3) { seenSet(id).delete(raw.id); persist(); } // un-see it so the next tick retries
    emit(id, "FAILED", `could not normalise ${raw.id} (attempt ${attempts}/3): ${n.error} — ${attempts < 3 ? "retrying next tick" : "offer skipped"}, still monitoring`, { offer: raw, error: n.error, attempt: attempts });
    return;
  }
  emit(id, "OFFER_NORMALISED",
    `${n.cached ? "cache hit" : n.mode}: ${describeProduct(n.canonical)}${n.is_bundle ? " [bundle]" : ""}${n.usage ? ` (${n.usage.input_tokens}+${n.usage.output_tokens} tokens, $${n.usage.usd.toFixed(4)})` : ""}`,
    { offer_id: raw.id, canonical: n.canonical, is_bundle: n.is_bundle, cached: n.cached, mode: n.mode, usage: n.usage });

  const offer: NormalisedOffer = { ...raw, canonical: n.canonical, is_bundle: n.is_bundle, total };
  const ev = evaluate(instruction, offer);
  if (!ev.qualified) {
    const failed = ev.checks.filter((c) => !c.pass);
    emit(id, "OFFER_REJECTED", `${raw.retailer} ${money(total)}: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`, { offer: summary(offer), checks: ev.checks });
    return;
  }
  emit(id, "OFFER_QUALIFIED", `${raw.retailer} ${money(total)} ${raw.currency} passes all ${ev.checks.length} checks → executing`, { offer: summary(offer), checks: ev.checks });
  await execute(instruction, offer);
}

// ---- The Exa monitor: the same pipeline, pointed at the real web -------------------
// Runs on its own far slower interval. The simulator is free and local so it polls every
// 3s; real retailers cost $0.001 a page and rate-limit, so they poll every 60s. Same
// rules engine, same executor, same price-mismatch abort at checkout.
import { EXA_MODE, exaOffers, exaSpendLine, type ExaOffer } from "./exa.js";
import { EXA_POLL_INTERVAL_MS } from "./env.js";

const MIN_CONFIDENCE = 0.8;
let exaTicking = false;

export function startExaMonitor() {
  if (EXA_MODE === "off") {
    console.log("[exa] off — set EXA_API_KEY in packages/backend/.env to watch real retailers");
    return;
  }
  console.log(`[exa] watching the real web every ${EXA_POLL_INTERVAL_MS / 1000}s`);
  setInterval(() => { void exaTick(); }, EXA_POLL_INTERVAL_MS);
  void exaTick();
}

export async function exaTick() {
  if (exaTicking) return;                 // a crawl or an execution is still in flight
  exaTicking = true;
  try {
    const active = [...state.instructions.values()].filter((i) => i.status === "ACTIVE");
    if (!active.length) return;
    for (const instruction of active) {
      let offers: ExaOffer[];
      try {
        offers = await exaOffers(instruction.product);
      } catch (e) {
        console.error(`[exa] ${instruction.id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const seen = seenSet(instruction.id);
      for (const raw of offers) {
        if (instruction.status !== "ACTIVE") break;
        if (!raw.in_stock || seen.has(raw.id)) continue;

        // A price the model is unsure it read correctly must never reach the executor.
        // This is a read-confidence gate, upstream of the rules engine's price ceiling.
        if (raw.confidence < MIN_CONFIDENCE) {
          emit(instruction.id, "OFFER_REJECTED",
            `${raw.retailer} ${money(raw.price)}: read confidence ${raw.confidence.toFixed(2)} < ${MIN_CONFIDENCE} — not acted on. ${raw.reason}`,
            { offer: { id: raw.id, retailer: raw.retailer, listing_title: raw.listing_title, price: raw.price, currency: raw.currency, url: raw.url }, source: "exa", confidence: raw.confidence, reason: raw.reason, availability_text: raw.availability_text });
          continue;
        }
        seen.add(raw.id);
        persist();
        emit(instruction.id, "OFFER_SEEN",
          `exa/${raw.retailer}: "${raw.availability_text}" — ${raw.reason}`,
          { source: "exa", url: raw.url, confidence: raw.confidence, exa_spend: exaSpendLine() });
        await consider(instruction, raw);
      }
    }
  } finally {
    exaTicking = false;
  }
}
