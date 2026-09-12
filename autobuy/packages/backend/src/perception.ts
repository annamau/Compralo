// The perception lane as HTTP: discovery and adjudication.
//
// Split deliberately by cost. /discover is one cheap Exa search ($0.007) that answers
// "who else sells this?" with a provisional, title-only match score. /adjudicate is a
// live crawl plus a model call that answers "what is THIS page actually offering, all in?"
// One expensive call supports many cheap checks — the canonical product is cached, so a
// retailer seen twice is not understood twice.
//
// Neither endpoint ever says whether to buy. They produce evidence; rules.ts decides.
import { Hono } from "hono";
import type { CanonicalProduct } from "../../shared/types.js";
import { EXA_MODE, adjudicate, discoverSellers, exaSpend, provisionalMatch } from "./exa.js";

export const perception = new Hono();

const offline = { error: "exa_off", message: "EXA_API_KEY is not set in packages/backend/.env — real-web discovery is disabled." };

// Canonical products, keyed by the identifier that makes two listings the same thing.
// A repeat offer from a retailer already seen costs nothing.
const canonical = new Map<string, CanonicalProduct>();
export const canonicalKey = (p: CanonicalProduct) => {
  const id = p.identifiers.gtin ?? p.identifiers.ean ?? p.identifiers.model ?? p.identifiers.sku;
  return id ? `id:${id.toLowerCase()}` : `name:${p.name.toLowerCase()}|${Object.entries(p.attributes).sort().map(([k, v]) => `${k}=${v}`).join(",")}`;
};
export function remember(p: CanonicalProduct): { product: CanonicalProduct; cached: boolean } {
  const k = canonicalKey(p);
  const hit = canonical.get(k);
  if (hit) return { product: hit, cached: true };
  canonical.set(k, p);
  return { product: p, cached: false };
}
export const canonicalCacheSize = () => canonical.size;

// POST /discover  { product }  → the same product at other retailers.
perception.post("/discover", async (c) => {
  if (EXA_MODE === "off") return c.json(offline, 503);
  const body = await c.req.json<{ product?: CanonicalProduct; force?: boolean }>().catch(() => ({}) as Record<string, never>);
  if (!body.product?.name) return c.json({ error: "need a product with at least a name" }, 400);

  const { product, cached } = remember(body.product);
  const t0 = Date.now();
  try {
    const sellers = await discoverSellers(product, body.force === true);
    const candidates = sellers
      .map((s) => ({ ...s, match_confidence: provisionalMatch(product, `${s.title} ${s.url}`) }))
      .sort((a, b) => b.match_confidence - a.match_confidence);
    return c.json({
      query_product: product.name,
      canonical_key: canonicalKey(product),
      canonical_cached: cached,
      candidates,
      note: "match_confidence is provisional and read from the title only. POST /adjudicate for the verdict on any one candidate.",
      ms: Date.now() - t0,
      exa_spend_usd: Number((exaSpend.discovery_usd + exaSpend.contents_usd).toFixed(4)),
    });
  } catch (e) {
    return c.json({ error: "discover_failed", message: e instanceof Error ? e.message : String(e) }, 502);
  }
});

// POST /adjudicate  { url, product }  → what that one page is offering, all in.
perception.post("/adjudicate", async (c) => {
  if (EXA_MODE === "off") return c.json(offline, 503);
  const body = await c.req.json<{ url?: string; product?: CanonicalProduct }>().catch(() => ({}) as Record<string, never>);
  if (!body.url || !body.product?.name) return c.json({ error: "need url and product" }, 400);

  const { product } = remember(body.product);
  const t0 = Date.now();
  try {
    const offer = await adjudicate(body.url, product);
    if (!offer) {
      return c.json({
        url: body.url, is_the_target_product: false,
        verdict: "Could not read that page as a listing for this product.", ms: Date.now() - t0,
      });
    }
    return c.json({
      url: offer.url,
      retailer: offer.retailer,
      is_the_target_product: true,
      listing_title: offer.listing_title,
      in_stock: offer.in_stock,
      availability_text: offer.availability_text,
      condition: offer.condition,
      currency: offer.currency,
      economics: {
        price: offer.price,
        shipping: offer.shipping,
        hidden_costs: offer.hidden_costs,
        all_in_total: offer.all_in_total,   // the number a limit must be tested against
      },
      confidence: offer.confidence,
      reason: offer.reason,
      ms: Date.now() - t0,
    });
  } catch (e) {
    return c.json({ error: "adjudicate_failed", message: e instanceof Error ? e.message : String(e) }, 502);
  }
});
