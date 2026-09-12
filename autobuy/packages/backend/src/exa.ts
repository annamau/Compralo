// Exa as a second offer source: real listings from the real web, emitted in the same
// RawOffer shape the market simulator uses, so nothing downstream changes.
//
// Two Exa calls with very different costs and very different cadences:
//   discovery   exa.search()      $7.00 / 1k requests   → who sells this? runs rarely, TTL-cached
//   stock check exa.getContents() $1.00 / 1k pages      → what do they say NOW? runs every tick
//
// That 7x gap is the whole design. Searching on every tick would be the obvious
// implementation and it is the expensive, slow, wrong one: the set of retailers
// carrying a product barely changes, while their stock changes constantly.
//
// With EXA_API_KEY unset the module reports mode "off" and returns no offers, so the
// simulator demo keeps working untouched.
import { Exa, type SearchResult } from "exa-js";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { CanonicalProduct, RawOffer } from "../../shared/types.js";
import { recordUsage } from "./state.js";
import { EXA_DISCOVERY_TTL_MS, EXA_DOMAINS, EXA_MAX_SELLERS, EXA_PAGE_CHARS } from "./env.js";

export const EXA_MODE: "live" | "off" = process.env.EXA_API_KEY ? "live" : "off";

const exa = EXA_MODE === "live" ? new Exa(process.env.EXA_API_KEY) : null;
const anthropic = new Anthropic();

// ---- Cost accounting. Exa returns costDollars on every response; we bank the real
// figure rather than an estimate, so the demo can quote a measured cost per check.
export const exaSpend = { discovery_usd: 0, contents_usd: 0, searches: 0, pages: 0 };
const bank = (kind: "discovery" | "contents", cost: unknown, n: number) => {
  const usd = typeof cost === "object" && cost && "total" in cost ? Number((cost as { total: number }).total) || 0 : 0;
  if (kind === "discovery") { exaSpend.discovery_usd += usd; exaSpend.searches += 1; }
  else { exaSpend.contents_usd += usd; exaSpend.pages += n; }
  return usd;
};
export const exaSpendLine = () =>
  `${exaSpend.searches} search + ${exaSpend.pages} page reads = $${(exaSpend.discovery_usd + exaSpend.contents_usd).toFixed(4)}`;

// ---- Discovery ------------------------------------------------------------------
export type Seller = { url: string; retailer: string; title: string };

const retailerOf = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, "").split(".")[0]; }
  catch { return "unknown"; }
};

/** A search query aimed at product pages, not reviews or news. Identifiers first — a
 *  model number or SKU is the strongest signal that two listings are the same thing. */
export function queryFor(p: CanonicalProduct): string {
  const id = p.identifiers.model ?? p.identifiers.sku ?? p.identifiers.gtin ?? p.identifiers.ean ?? "";
  const attrs = Object.values(p.attributes).slice(0, 2).join(" ");
  return [p.brand, p.name, attrs, id, "buy price in stock"].filter(Boolean).join(" ");
}

const discoveryCache = new Map<string, { at: number; sellers: Seller[] }>();
export const resetExaCache = () => discoveryCache.clear();

export async function discoverSellers(product: CanonicalProduct, force = false): Promise<Seller[]> {
  if (!exa) return [];
  const q = queryFor(product);
  const hit = discoveryCache.get(q);
  if (!force && hit && Date.now() - hit.at < EXA_DISCOVERY_TTL_MS) return hit.sellers;

  const t0 = Date.now();
  const r = await exa.search(q, {
    type: "fast",                                   // stock checking wants latency, not depth
    numResults: EXA_MAX_SELLERS,
    ...(EXA_DOMAINS.length ? { includeDomains: EXA_DOMAINS } : {}),
  });
  const usd = bank("discovery", (r as { costDollars?: unknown }).costDollars, 0);

  const seen = new Set<string>();
  const sellers: Seller[] = [];
  for (const res of r.results) {
    const retailer = retailerOf(res.url);
    if (seen.has(retailer)) continue;               // one listing per retailer, the best-ranked
    seen.add(retailer);
    sellers.push({ url: res.url, retailer, title: res.title ?? "" });
  }
  discoveryCache.set(q, { at: Date.now(), sellers });
  console.log(`[exa/discover] "${q}" → ${sellers.length} retailer(s) in ${Date.now() - t0} ms, $${usd.toFixed(4)}: ${sellers.map((s) => s.retailer).join(", ")}`);
  return sellers;
}

// ---- Stock check ----------------------------------------------------------------
/** One call covers every seller. maxAgeHours: 0 forces a live crawl — a cached page
 *  would report yesterday's availability, which makes the entire watch meaningless. */
async function fetchPages(sellers: Seller[]): Promise<Map<string, string>> {
  if (!exa || !sellers.length) return new Map();
  const t0 = Date.now();
  const r = await exa.getContents(sellers.map((s) => s.url), {
    text: { maxCharacters: EXA_PAGE_CHARS, includeHtmlTags: true },
    maxAgeHours: 0,
  });
  const usd = bank("contents", (r as { costDollars?: unknown }).costDollars, r.results.length);
  console.log(`[exa/contents] ${r.results.length} page(s) live-crawled in ${Date.now() - t0} ms, $${usd.toFixed(4)}`);
  return new Map(r.results.map((res: SearchResult<{ text: true }>) => [res.url, res.text ?? ""]));
}

// ---- Extraction -----------------------------------------------------------------
// Exa hands back page text; turning "Currently unavailable — join the waitlist" and a
// price split across three elements into {in_stock:false, price:430} is Claude's job.
// reason is not decoration: it is surfaced on the event so the demo shows the model's
// stated justification for reading a page the way it did.
const OfferOut = z.strictObject({
  is_the_target_product: z.boolean(),
  listing_title: z.string(),
  price: z.number().nullable(),
  shipping: z.number().nullable(),
  currency: z.string().nullable(),
  condition: z.string(),
  hidden_costs: z.array(z.strictObject({ label: z.string(), amount: z.number() })),
  all_in_total: z.number().nullable(),
  in_stock: z.boolean(),
  availability_text: z.string(),
  confidence: z.number(),
  reason: z.string(),
});

const EXTRACT_SYSTEM = `You are the offer-extraction step of AutoBuy. You receive one target product and the crawled text of one retail page. Report what THIS page is currently offering.

Rules
1. is_the_target_product: false when the page sells a different model, capacity, edition or generation than the target, or is a review, news article, listicle or category page rather than a buyable listing. When false, still fill every other field with what you can see.
2. price: the price of the target item itself. Retail pages are full of decoys — RRP, "was" prices, savings, monthly finance, bundle add-ons, and "customers also viewed" rails carrying entirely different products. Never take the first number you find. If the page shows no price for this item, use null.
3. shipping: delivery cost as a number, 0 when free, null when the page does not say.
4. hidden_costs: every mandatory charge beyond price and shipping that a buyer only meets later — handling, booking, import or customs charges, mandatory insurance, card surcharges, compulsory "protection" add-ons pre-ticked in the basket. Label each in the page's own words. Omit optional extras and anything a buyer can decline. Empty array when there are none.
5. all_in_total: price + shipping + every hidden_cost, in the currency field. This is the number a purchase limit must be tested against — not the headline price. null when price is null.
6. currency: ISO 4217. Infer from the symbol and the retailer's country when not stated.
7. in_stock: false when the page says sold out, out of stock, unavailable, notify me, back-order, pre-order, waitlist or coming soon. A page offering only an email-notification form is NOT in stock.
8. availability_text: the page's own words about availability, quoted verbatim, max 100 characters.
9. condition: "new", "refurbished" or "used".
10. confidence: 0-1, your confidence in price and in_stock together. Below 0.8 the purchase gate will refuse to act on this reading, so be honest rather than generous. A price you inferred rather than read is low confidence.
11. reason: one sentence, max 160 characters, saying which element you took the price from, what told you the stock state, and naming any hidden cost you found. Write it as one plain sentence a person would say out loud, not a form error. This is shown to the user verbatim.`;

// Opus 5 list price, $/MTok — input 5, output 25, cache write 6.25, cache read 0.50
function usageLine(u: Anthropic.Messages.Usage) {
  const cw = u.cache_creation_input_tokens ?? 0, cr = u.cache_read_input_tokens ?? 0;
  return {
    input_tokens: u.input_tokens, output_tokens: u.output_tokens,
    cache_write_tokens: cw, cache_read_tokens: cr,
    usd: (u.input_tokens * 5 + cw * 6.25 + cr * 0.5 + u.output_tokens * 25) / 1e6,
  };
}

export type HiddenCost = { label: string; amount: number };
export type ExaOffer = RawOffer & {
  confidence: number; reason: string; availability_text: string;
  hidden_costs: HiddenCost[];
  all_in_total: number | null;   // price + shipping + hidden costs — the number the limit is tested against
};

async function extractOne(seller: Seller, text: string, target: CanonicalProduct): Promise<ExaOffer | null> {
  if (!text.trim()) { console.warn(`[exa/extract] ${seller.retailer}: empty crawl, skipped`); return null; }
  try {
    const r = await anthropic.messages.parse({
      model: "claude-opus-5",
      max_tokens: 4000,
      system: [{ type: "text", text: EXTRACT_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [
        { type: "text", text: `<target>\n${JSON.stringify(target)}\n</target>` },
        { type: "text", text: `URL: ${seller.url}` },
        { type: "text", text: `<page>\n${text}\n</page>` },
      ] }],
      output_config: { format: zodOutputFormat(OfferOut), effort: "low" },
    });
    const usage = usageLine(r.usage);
    recordUsage("extract", usage);
    const o = r.parsed_output;
    if (!o) { console.warn(`[exa/extract] ${seller.retailer}: no structured output (${r.stop_reason})`); return null; }
    console.log(`[exa/extract] ${seller.retailer}: target=${o.is_the_target_product} stock=${o.in_stock} price=${o.price ?? "null"} all-in=${o.all_in_total ?? "null"}${o.hidden_costs.length ? ` (+${o.hidden_costs.length} hidden)` : ""} conf=${o.confidence.toFixed(2)} $${usage.usd.toFixed(4)} — ${o.reason}`);
    if (!o.is_the_target_product) return null;
    return {
      id: `exa-${seller.retailer}-${Buffer.from(seller.url).toString("base64url").slice(0, 8)}`,
      retailer: seller.retailer,
      listing_title: o.listing_title || seller.title,
      price: o.price ?? 0,
      shipping: o.shipping ?? 0,
      currency: o.currency ?? target.currency ?? "GBP",
      condition: o.condition || "new",
      in_stock: o.in_stock && o.price !== null,     // in stock at an unknown price cannot be bought
      url: seller.url,
      confidence: o.confidence,
      reason: o.reason,
      availability_text: o.availability_text,
      hidden_costs: o.hidden_costs,
      all_in_total: o.all_in_total,
    };
  } catch (e) {
    console.error(`[exa/extract] ${seller.retailer} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ---- The one function the monitor calls -----------------------------------------
/** Discover (cached) → live-crawl every seller in one call → extract in parallel. */
export async function exaOffers(target: CanonicalProduct): Promise<ExaOffer[]> {
  if (EXA_MODE === "off") return [];
  const sellers = await discoverSellers(target);
  if (!sellers.length) return [];
  const pages = await fetchPages(sellers);
  const offers = await Promise.all(sellers.map((s) => extractOne(s, pages.get(s.url) ?? "", target)));
  return offers.filter((o): o is ExaOffer => o !== null);
}

/** Adjudicate one known URL: live-crawl it and report what it is offering. Facts only —
 *  same product or not, the true all-in total, hidden costs, condition, stock. Never a
 *  buy/no-buy verdict; the rules engine owns that decision and this owns the evidence. */
export async function adjudicate(url: string, target: CanonicalProduct): Promise<ExaOffer | null> {
  if (!exa) return null;
  const seller: Seller = { url, retailer: retailerOf(url), title: "" };
  const pages = await fetchPages([seller]);
  return extractOne(seller, pages.get(url) ?? "", target);
}

/** Provisional, title-only match score for a discovery candidate. Free and instant:
 *  a stated identifier is near-certainty, otherwise significant-token overlap. The real
 *  verdict costs a crawl and a model call, and that is what /adjudicate is for. */
const STOP = new Set(["buy", "price", "in", "stock", "the", "for", "with", "and", "new", "uk", "online", "best", "deal", "cheap", "sale", "shop"]);
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));

export function provisionalMatch(target: CanonicalProduct, title: string): number {
  const hay = title.toLowerCase();
  for (const id of Object.values(target.identifiers)) {
    if (id && hay.includes(id.toLowerCase())) return 0.95;   // identifier stated outright
  }
  const want = new Set(tokens([target.brand, target.name, ...Object.values(target.attributes)].filter(Boolean).join(" ")));
  if (!want.size) return 0.3;
  const got = new Set(tokens(title));
  let hits = 0;
  for (const t of want) if (got.has(t)) hits += 1;
  return Math.min(0.9, Math.max(0.15, hits / want.size));
}
