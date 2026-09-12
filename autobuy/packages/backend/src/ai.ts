// The AI layer. Understands product pages and normalises listings — nothing else.
// With ANTHROPIC_API_KEY unset, both calls fall back to deterministic fixtures so the
// pipeline runs offline; the mode is logged at boot and reported on every event.
import type { CanonicalProduct, Control, RawOffer } from "../../shared/types.js";
import { fixtureFor, heuristicNormalise, type Understanding } from "./fixtures.js";
import { extractProduct, listingPageReason } from "./extract.js";

export const AI_MODE: "claude" | "hardcoded" = process.env.ANTHROPIC_API_KEY ? "claude" : "hardcoded";

export type UsageLine = { input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number; usd: number };
export type Understood = Understanding & { mode: string; source?: string; page_title?: string; usage?: UsageLine };
export type Normalised = { canonical: CanonicalProduct; is_bundle: boolean; cached: boolean; mode: string; usage?: UsageLine };
export type NormaliseFailure = { error: string };

const cache = new Map<string, { canonical: CanonicalProduct; is_bundle: boolean }>();
export function resetAiCache() { cache.clear(); }
export const cacheSize = () => cache.size;

export async function understand(url: string, html: string, title = "", screenshot?: string): Promise<Understood> {
  if (AI_MODE === "hardcoded") {
    // No key: read the page deterministically. The PS5 fixture only stands in for PS5-looking pages that defeat the extractor.
    const listing = listingPageReason(url, title);
    if (listing) throw new Error(`This looks like ${listing}, not a product. Open a single product page and the panel will read it.`);
    const ex = extractProduct(url, html, title);
    if (ex) return { product: ex.product, controls: ex.controls, mode: "extracted", source: ex.source, page_title: ex.page_title };
    const isSearchPage = /(^|\.)(google|bing|duckduckgo|yahoo|youtube)\.|\/search|[?&]q=/i.test(url);
    if (!isSearchPage && /ps5|playstation|nike|air max|adidas|sneaker|zapatilla/i.test(`${url} ${title}`)) return { ...fixtureFor(url, title), mode: "fixture", source: "fixture", page_title: title };
    throw new Error(`No product found on this page (no ld+json Product, no product meta tags, no title). URL: ${url}`);
  }
  const { understandWithClaude } = await import("./claude.js");
  return understandWithClaude(url, html, screenshot);
}

export async function normaliseOffer(raw: RawOffer, target: CanonicalProduct): Promise<Normalised | NormaliseFailure> {
  const hit = cache.get(raw.id);
  if (hit) return { ...hit, cached: true, mode: AI_MODE };
  let r: { canonical: CanonicalProduct; is_bundle: boolean; usage?: UsageLine } | NormaliseFailure;
  if (AI_MODE === "hardcoded") r = heuristicNormalise(raw, target);
  else {
    const { normaliseWithClaude } = await import("./claude.js");
    r = await normaliseWithClaude(raw, target);
  }
  if ("error" in r) return r;
  cache.set(raw.id, { canonical: r.canonical, is_bundle: r.is_bundle });
  return { canonical: r.canonical, is_bundle: r.is_bundle, cached: false, mode: AI_MODE, usage: r.usage };
}

export const describeProduct = (p: CanonicalProduct) =>
  `${p.name} {${Object.entries(p.attributes).map(([k, v]) => `${k}=${v}`).join(", ")}}`;

export type { Control };
