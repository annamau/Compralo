// The three Claude calls live here (the third, parseInstruction, is optional and not built).
// Loaded lazily by ai.ts only when ANTHROPIC_API_KEY is set. Model: claude-opus-5, exact string.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { CanonicalProduct, Control, RawOffer } from "../../shared/types.js";
import type { Understood, UsageLine } from "./ai.js";
import { recordUsage } from "./state.js";
import { sanitise } from "./sanitise.js";

export const MODEL = "claude-opus-5";
const client = new Anthropic();

// ---- Schemas: structured outputs need additionalProperties:false on every object, so strictObject
// everywhere and no z.record — attributes travel as {key,value} pairs and are folded afterwards.
const AttrOut = z.strictObject({ key: z.string(), value: z.string() });
const ProductOut = z.strictObject({
  name: z.string(),
  category: z.string(),
  brand: z.string().nullable(),
  identifiers: z.strictObject({ gtin: z.string().nullable(), ean: z.string().nullable(), sku: z.string().nullable(), model: z.string().nullable() }),
  attributes: z.array(AttrOut),
  listed_price: z.number().nullable(),
  currency: z.string().nullable(),
  in_stock: z.boolean(),
});
const ControlOut = z.strictObject({
  key: z.string(),
  label: z.string(),
  type: z.enum(["select", "multiselect", "number", "boolean"]),
  options: z.array(z.string()),
  default: z.string(),
  required_match: z.boolean(),
});
const UnderstandOut = z.strictObject({ product: ProductOut, controls: z.array(ControlOut) });
const NormaliseOut = z.strictObject({ canonical: ProductOut, is_bundle: z.boolean() });

// ---- Static system prompts (cached; the volatile page content follows in the user turn) ----
const UNDERSTAND_SYSTEM = `You are the product-understanding step of AutoBuy, a purchasing agent. You receive one retail product page: its URL, any ld+json blocks, and sanitised page HTML. Return the canonical product and the purchasing controls a buyer of THIS product needs.

Rules
1. Prefer structured data. If <ld_json> contains a Product, take name, brand, sku, gtin/ean/mpn, price, currency and availability from it before reading the page. Page text only fills gaps.
2. Identifiers verbatim. Copy GTIN/EAN/SKU/model strings exactly as written (digits, dashes, case). Never guess, pad or invent one; use null when absent.
3. name: the canonical product name without retailer noise, promotions or bundle contents ("PlayStation 5 Slim Digital Edition 1TB", not "SONY PS5 Slim Digital 1TB Console - FREE DELIVERY"). brand: null if unknown.
4. category: one lowercase snake_case token such as games_console, footwear, gpu, phone, headphones, lego, appliance, other.
5. attributes: 2-6 variant-defining facts about the item on this page as key/value pairs: short lowercase snake_case keys and short lowercase values (edition: digital, storage: 1tb, size_eu: 42, colour: white, capacity: 256gb). Every control key below must also appear here with the page's value.
6. listed_price: the number shown for this exact item (no symbols, no thousands separators), null if none. currency: ISO 4217 code, null if unknown. in_stock: false when the page says sold out, unavailable, notify me, coming soon, or ld+json availability is not InStock.
7. controls: 2-5 purchasing controls that matter for THIS product. Each key is an attribute key from rule 5. type "select" for a small closed set (2-8 lowercase options, the page's value first and as default); "multiselect" when a buyer would reasonably accept several values (default = comma-separated list); "number" for numeric thresholds; "boolean" for yes/no (default "true" or "false"). required_match true when a different value means a different product (edition, size, storage, shoe colour, model year); false for preferences (console cover colour, packaging, region when irrelevant).
8. Never produce controls for price, condition, retailer, bundles, quantity, delivery or deadline; the app has universal fields for those.
9. Every field is required. Use null only where the schema allows it; use "" for a default you cannot determine and [] for options on number/boolean controls.`;

const NORMALISE_SYSTEM = `You are the listing-normalisation step of AutoBuy. You receive a target product (canonical form with attribute keys) and one raw retail listing. Return the listing's canonical form and whether it is a bundle.

Rules
1. canonical.attributes uses exactly the target's attribute keys, one entry per key, values in the target's vocabulary (edition: digital|disc, storage: 1tb, size_eu: 42). If the listing title does not state a value, copy the target's value; never invent a different one. If the title states a different value, report it faithfully: a "Disc Edition" title is edition: disc even when the target is digital.
2. canonical.name: the product the listing names, without retailer noise. category and brand: copy from the target unless the listing is clearly a different kind of product. identifiers: only those literally present in the listing, verbatim; otherwise null.
3. listed_price = price, currency = currency, in_stock = in_stock, copied from the listing without arithmetic.
4. is_bundle is true when the listing includes anything beyond the single product (a game, an extra controller, a gift card, "+", "bundle", "pack", "with ..."); false for the bare product even if in-box accessories are listed.
5. Short lowercase values. No explanations.`;

// ---- Usage accounting: Opus 5 list price, $/MTok — input 5, output 25, cache write 6.25, cache read 0.50
function usageLine(u: Anthropic.Messages.Usage): UsageLine {
  const cw = u.cache_creation_input_tokens ?? 0, cr = u.cache_read_input_tokens ?? 0;
  const usd = (u.input_tokens * 5 + cw * 6.25 + cr * 0.5 + u.output_tokens * 25) / 1e6;
  return { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_write_tokens: cw, cache_read_tokens: cr, usd };
}
const fmtUsage = (u: UsageLine) => `in=${u.input_tokens} out=${u.output_tokens} cache_w=${u.cache_write_tokens} cache_r=${u.cache_read_tokens} $${u.usd.toFixed(4)}`;

type ProductOutT = z.infer<typeof ProductOut>;
type ControlOutT = z.infer<typeof ControlOut>;

function toProduct(p: ProductOutT): CanonicalProduct {
  const identifiers: CanonicalProduct["identifiers"] = {};
  for (const k of ["gtin", "ean", "sku", "model"] as const) { const v = p.identifiers[k]; if (v && v.trim()) identifiers[k] = v.trim(); }
  const attributes: Record<string, string> = {};
  for (const a of p.attributes) { const k = a.key.trim().toLowerCase().replace(/[\s-]+/g, "_"); if (k) attributes[k] = a.value.trim().toLowerCase(); }
  return { name: p.name.trim(), category: p.category.trim().toLowerCase(), brand: p.brand?.trim() || null, identifiers, attributes, listed_price: p.listed_price, currency: p.currency ? p.currency.toUpperCase() : null, in_stock: p.in_stock };
}

function toControl(c: ControlOutT): Control {
  const key = c.key.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const options = c.type === "select" || c.type === "multiselect" ? c.options.map((o) => o.trim().toLowerCase()).filter(Boolean) : undefined;
  const raw = c.default.trim();
  const def: Control["default"] =
    c.type === "boolean" ? raw.toLowerCase() === "true"
    : c.type === "number" ? (Number.isFinite(Number(raw)) ? Number(raw) : 0)
    : c.type === "multiselect" ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : raw.toLowerCase();
  return { key, label: c.label.trim(), type: c.type, ...(options ? { options } : {}), default: def, required_match: c.required_match };
}

export async function understandWithClaude(url: string, html: string, screenshot?: string): Promise<Understood> {
  const s = sanitise(html);
  const shot = screenshot?.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  const imageBlock: Anthropic.Messages.ImageBlockParam[] = shot ? [{ type: "image", source: { type: "base64", media_type: shot[1] as "image/jpeg" | "image/png" | "image/webp", data: shot[2] } }] : [];
  const t0 = Date.now();
  const r = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: "text", text: UNDERSTAND_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [
      { type: "text", text: `URL: ${url}` },
      ...imageBlock,
      { type: "text", text: s.ldjson ? `<ld_json>\n${s.ldjson}\n</ld_json>` : "<ld_json>none on this page</ld_json>" },
      { type: "text", text: `<page>\n${s.text}\n</page>` },
    ] }],
    output_config: { format: zodOutputFormat(UnderstandOut), effort: "medium" },
  });
  const usage = usageLine(r.usage);
  recordUsage("understand", usage);
  console.log(`[ai/understand] ${Date.now() - t0} ms, page ${s.original_chars}→${s.sent_chars} chars, ld+json ${s.ldjson ? "yes" : "no"}, screenshot ${shot ? "yes" : "no"}, ${fmtUsage(usage)}, stop=${r.stop_reason}`);
  if (r.stop_reason === "refusal") throw new Error(`Claude declined to read this page (refusal${r.stop_details?.category ? `: ${r.stop_details.category}` : ""})`);
  if (!r.parsed_output) throw new Error(`Claude returned no structured output (stop_reason=${r.stop_reason})`);
  return { product: toProduct(r.parsed_output.product), controls: r.parsed_output.controls.map(toControl), mode: "claude", source: s.ldjson ? "claude + ld+json" : "claude", usage };
}

export async function normaliseWithClaude(raw: RawOffer, target: CanonicalProduct): Promise<{ canonical: CanonicalProduct; is_bundle: boolean; usage: UsageLine } | { error: string }> {
  const t0 = Date.now();
  try {
    const listing = { title: raw.listing_title, retailer: raw.retailer, price: raw.price, shipping: raw.shipping, currency: raw.currency, condition: raw.condition, in_stock: raw.in_stock, url: raw.url };
    const r = await client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system: [{ type: "text", text: NORMALISE_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `<target>\n${JSON.stringify(target)}\n</target>\n<listing>\n${JSON.stringify(listing)}\n</listing>` }],
      output_config: { format: zodOutputFormat(NormaliseOut), effort: "low" },
    });
    const usage = usageLine(r.usage);
    recordUsage("normalise", usage);
    console.log(`[ai/normalise] ${raw.id} ${Date.now() - t0} ms, ${fmtUsage(usage)}, stop=${r.stop_reason}`);
    if (r.stop_reason === "refusal") return { error: `Claude declined (refusal${r.stop_details?.category ? `: ${r.stop_details.category}` : ""})` };
    if (!r.parsed_output) return { error: `no structured output (stop_reason=${r.stop_reason})` };
    return { canonical: toProduct(r.parsed_output.canonical), is_bundle: r.parsed_output.is_bundle, usage };
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? `Anthropic API ${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e);
    console.error(`[ai/normalise] ${raw.id} failed after ${Date.now() - t0} ms: ${msg}`);
    return { error: msg };
  }
}
