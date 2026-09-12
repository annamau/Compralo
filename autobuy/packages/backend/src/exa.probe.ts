// Standalone probe: proves the Exa leg end to end without starting the backend or
// touching the running demo.   npm run exa:probe -w packages/backend -- "<product>"
//
// Prints what a single monitor tick would see, and what that tick costs.
import "./env.js";
import { discoverSellers, exaOffers, exaSpend, exaSpendLine, EXA_MODE, queryFor } from "./exa.js";
import { PS5 } from "./fixtures.js";
import type { CanonicalProduct } from "../../shared/types.js";

const arg = process.argv.slice(2).join(" ").trim();
const target: CanonicalProduct = arg
  ? { ...PS5.product, name: arg, brand: null, identifiers: {}, attributes: {} }
  : PS5.product;

if (EXA_MODE === "off") { console.error("EXA_API_KEY is not set — add it to packages/backend/.env"); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) console.warn("! ANTHROPIC_API_KEY unset: discovery will run, extraction will fail.\n");

console.log(`target : ${target.name}`);
console.log(`query  : ${queryFor(target)}\n`);

const t0 = Date.now();
const sellers = await discoverSellers(target);
if (!sellers.length) { console.error("no sellers found — try a broader product name, or clear EXA_DOMAINS"); process.exit(1); }
for (const s of sellers) console.log(`  ${s.retailer.padEnd(16)} ${s.url}`);

console.log("\nlive-crawling and extracting...\n");
const offers = await exaOffers(target);

console.log(`\n${"retailer".padEnd(16)} ${"stock".padEnd(7)} ${"price".padEnd(10)} conf  title`);
console.log("-".repeat(92));
for (const o of offers) {
  console.log(`${o.retailer.padEnd(16)} ${(o.in_stock ? "IN" : "OUT").padEnd(7)} ${`${o.currency} ${o.price}`.padEnd(10)} ${o.confidence.toFixed(2)}  ${o.listing_title.slice(0, 44)}`);
  console.log(`${" ".repeat(16)} └ ${o.reason}`);
}

const claudeUsd = offers.length ? 0 : 0; // per-call figures already printed by [exa/extract]
console.log(`\n${offers.length} offer(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`exa cost : ${exaSpendLine()}`);
console.log(`           discovery $${exaSpend.discovery_usd.toFixed(4)} (cached for the next hour) + pages $${exaSpend.contents_usd.toFixed(4)} (every tick)`);
void claudeUsd;
