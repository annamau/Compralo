// Deterministic page reader used when there is no ANTHROPIC_API_KEY. No model, no guessing beyond
// keyword rules: ld+json Product first, then Open Graph / product meta tags, then the selectors
// big retailers use, then the <title>. Category-specific control templates give the panel
// product-shaped controls even without Claude. Returns null when no product can be found.
import * as cheerio from "cheerio";
import type { CanonicalProduct, Control } from "../../shared/types.js";

export type Extracted = { product: CanonicalProduct; controls: Control[]; source: string; page_title: string };

const str = (x: unknown): string | null => {
  if (typeof x === "string") return x.trim() || null;
  if (Array.isArray(x)) return str(x[0]);
  if (x && typeof x === "object" && "name" in (x as Record<string, unknown>)) return str((x as Record<string, unknown>).name);
  return null;
};
/** "1.299,00" → 1299, "1,299.00" → 1299, "449,99" → 449.99, "449.99" → 449.99, "1.299" → 1299 */
export function parseMoney(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x !== "string") return null;
  const s = x.replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  let normalised: string;
  if (lastDot >= 0 && lastComma >= 0) normalised = lastDot > lastComma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  else if (lastComma >= 0) normalised = /,\d{1,2}$/.test(s) ? s.replace(/,/g, (m, i) => (i === lastComma ? "." : "")) : s.replace(/,/g, "");
  else if (lastDot >= 0) normalised = /\.\d{3}$/.test(s) && (s.match(/\./g) ?? []).length === 1 && s.length > 4 ? s.replace(".", "") : s.replace(/\.(?=.*\.)/g, "");
  else normalised = s;
  const n = Number(normalised);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const SYMBOL_CURRENCY: Record<string, string> = { "€": "EUR", "£": "GBP", "$": "USD", "¥": "JPY", "zł": "PLN", "kr": "SEK", "CHF": "CHF" };
const TLD_CURRENCY: Record<string, string> = { es: "EUR", de: "EUR", fr: "EUR", it: "EUR", nl: "EUR", pt: "EUR", ie: "EUR", at: "EUR", be: "EUR", uk: "GBP", us: "USD", com: "USD", ca: "CAD", au: "AUD", jp: "JPY", ch: "CHF", se: "SEK", pl: "PLN" };

type LdNode = Record<string, unknown>;
function walk(node: unknown, out: LdNode[]) {
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return; }
  if (!node || typeof node !== "object") return;
  const o = node as LdNode;
  out.push(o);
  for (const k of ["@graph", "mainEntity", "hasVariant", "itemListElement", "item", "offers"]) if (k in o) walk(o[k], out);
}
const isType = (o: LdNode, t: string) => { const ty = o["@type"]; return typeof ty === "string" ? ty.includes(t) : Array.isArray(ty) && ty.some((x) => typeof x === "string" && x.includes(t)); };

function firstOffer(o: LdNode): LdNode | null {
  const offers = o.offers;
  if (Array.isArray(offers)) return (offers[0] as LdNode) ?? null;
  if (offers && typeof offers === "object") return offers as LdNode;
  const variants = o.hasVariant;
  if (Array.isArray(variants)) for (const v of variants) { const f = firstOffer(v as LdNode); if (f) return f; }
  return null;
}

const CATEGORY_RULES: [string, RegExp][] = [
  ["games_console", /\b(playstation|ps5|ps4|xbox|nintendo switch|steam deck|consola)\b/i],
  ["footwear", /\b(zapatilla|zapatillas|zapato|zapatos|bota|botas|sandalia|sandalias|deportivas|sneaker|sneakers|shoe|shoes|trainer|trainers|air max|air force|jordan|boot|boots|running shoe|calzado|dunk|samba|gazelle)\b/i],
  ["gpu", /\b(rtx|gtx|radeon|geforce|graphics card|tarjeta gr[aá]fica|rx \d{4})\b/i],
  ["phone", /\b(iphone|galaxy s\d+|pixel \d|smartphone|m[oó]vil|xiaomi|oneplus)\b/i],
  ["headphones", /\b(airpods|headphones|auriculares|earbuds|wh-1000|quietcomfort)\b/i],
  ["laptop", /\b(macbook|laptop|port[aá]til|thinkpad|zenbook|chromebook|notebook)\b/i],
  ["lego", /\blego\b/i],
  ["watch", /\b(apple watch|smartwatch|garmin|reloj)\b/i],
];
function guessCategory(hay: string): string { for (const [cat, re] of CATEGORY_RULES) if (re.test(hay)) return cat; return "other"; }

const COLOURS = ["black", "white", "grey", "gray", "red", "blue", "green", "pink", "purple", "silver", "gold", "beige", "brown", "orange", "yellow", "negro", "blanco", "gris", "rojo", "azul", "verde", "rosa", "morado", "plata", "dorado"];
const COLOUR_MAP: Record<string, string> = { gray: "grey", negro: "black", blanco: "white", gris: "grey", rojo: "red", azul: "blue", verde: "green", rosa: "pink", morado: "purple", plata: "silver", dorado: "gold" };
function detectColour(hay: string): string | null { const m = hay.toLowerCase().match(new RegExp(`\\b(${COLOURS.join("|")})\\b`)); return m ? (COLOUR_MAP[m[1]] ?? m[1]) : null; }

/** Attributes detected from the name/url plus the controls a buyer of this category needs. */
function controlsFor(category: string, hay: string): { attributes: Record<string, string>; controls: Control[] } {
  const a: Record<string, string> = {};
  const colour = detectColour(hay);
  const sel = (key: string, label: string, options: string[], def: string, required: boolean): Control => ({ key, label, type: "select", options, default: def, required_match: required });
  switch (category) {
    case "games_console": {
      a.edition = /\bdigital\b/i.test(hay) ? "digital" : "disc";
      const st = hay.match(/(\d)\s?tb\b/i); a.storage = st ? `${st[1]}TB` : "1TB";
      a.colour = colour ?? "white";
      return { attributes: a, controls: [sel("edition", "Edition", ["digital", "disc"], a.edition, true), sel("storage", "Storage", ["1TB", "2TB"], a.storage, true), sel("colour", "Colour", ["white", "black", "grey"], a.colour, false)] };
    }
    case "footwear": {
      const sz = hay.match(/\b(?:eu|talla|size)\s?(3[5-9]|4[0-9])(?:[.,]5)?\b/i); a.size = sz ? sz[1] : "42";
      a.colour = colour ?? "white";
      a.width = "regular";
      return { attributes: a, controls: [{ key: "size", label: "Size (EU)", type: "multiselect", options: ["38", "39", "40", "41", "42", "43", "44", "45", "46"], default: [a.size], required_match: true }, sel("colour", "Colour", ["white", "black", "grey", "red", "blue", "green"], a.colour, true), sel("width", "Width", ["regular", "wide"], a.width, false)] };
    }
    case "gpu": {
      const vram = hay.match(/(\d{1,2})\s?gb\b/i); a.vram = vram ? `${vram[1]}GB` : "16GB";
      const model = hay.match(/\b(rtx\s?\d{4}\s?(?:ti|super)?|rx\s?\d{4}\s?(?:xt)?)\b/i); if (model) a.model = model[1].toLowerCase().replace(/\s+/g, " ");
      const brand = hay.match(/\b(asus|msi|gigabyte|zotac|palit|pny|sapphire|powercolor|evga|inno3d)\b/i); a.manufacturer = brand ? brand[1].toLowerCase() : "any";
      return { attributes: a, controls: [sel("vram", "Memory", ["8GB", "12GB", "16GB", "24GB", "32GB"], a.vram, true), { key: "manufacturer", label: "Manufacturer", type: "multiselect", options: ["asus", "msi", "gigabyte", "zotac", "palit", "pny", "sapphire", "powercolor"], default: a.manufacturer === "any" ? ["asus", "msi", "gigabyte", "zotac", "palit", "pny", "sapphire", "powercolor"] : [a.manufacturer], required_match: false }] };
    }
    case "phone": {
      const cap = hay.match(/(\d{3,4})\s?gb\b|(\d)\s?tb\b/i); a.capacity = cap ? (cap[1] ? `${cap[1]}GB` : `${cap[2]}TB`) : "256GB";
      a.colour = colour ?? "black";
      return { attributes: a, controls: [sel("capacity", "Capacity", ["128GB", "256GB", "512GB", "1TB"], a.capacity, true), sel("colour", "Colour", ["black", "white", "blue", "green", "pink", "silver", "gold"], a.colour, true)] };
    }
    case "laptop": {
      const ram = hay.match(/(\d{1,2})\s?gb\b/i); a.ram = ram ? `${ram[1]}GB` : "16GB";
      const st = hay.match(/(\d{3,4})\s?gb\b|(\d)\s?tb\b/gi); a.storage = "512GB";
      if (st) { const last = st[st.length - 1].toUpperCase().replace(/\s+/g, ""); if (last !== a.ram) a.storage = last; }
      a.colour = colour ?? "grey";
      return { attributes: a, controls: [sel("ram", "Memory", ["8GB", "16GB", "24GB", "32GB", "64GB"], a.ram, true), sel("storage", "Storage", ["256GB", "512GB", "1TB", "2TB"], a.storage, true), sel("colour", "Colour", ["grey", "silver", "black", "blue"], a.colour, false)] };
    }
    default: {
      a.colour = colour ?? "any";
      return { attributes: a, controls: [{ key: "colour", label: "Colour", type: "select", options: ["any", "black", "white", "grey", "red", "blue", "green"], default: a.colour, required_match: false }] };
    }
  }
}

/** Search results, category and listing pages are not products. Returns a reason, or null for a product-looking page. */
export function listingPageReason(url: string, title = ""): string | null {
  let path = "", query = "";
  try { const u = new URL(url); path = u.pathname; query = u.search; } catch { return null; }
  if (/\/(dp|gp\/product|gp\/aw\/d|product|products|producto|productos|p|pd|item|items|t|prod|artikel|articulo)\/[^/?#]+/i.test(path) || /\/[^/]*-p-?\d{4,}/i.test(path)) return null; // product paths win, whatever the query says
  if (/^\/(?:[a-z]{2}(?:[-_][a-z]{2})?\/)?(s|search|buscar|b|browse|gp\/(search|bestsellers|browse)|c|category|categories|collections?|shop|tienda|catalogo|catalogue|w)(\/|$)/i.test(path) || /[?&](k|q|query|search|keywords|node)=/i.test(query)) return "a search or category page";
  if (/\b(results? for|resultados? (de|para)|search results|resultados de b[uú]squeda)\b/i.test(title)) return "a search results page";
  return null;
}

/** Ordered price sources: retailer buy-box containers first, then generic patterns. Every match is tried, not just the first. */
const PRICE_SELECTORS = [
  "#corePrice_feature_div .a-offscreen", "#corePriceDisplay_desktop_feature_div .a-offscreen", "#apex_desktop .a-offscreen", ".priceToPay .a-offscreen", "#corePrice_feature_div .a-price-whole",
  "#price_inside_buybox", "#priceblock_ourprice", "#priceblock_dealprice", "#buybox .a-offscreen", "#centerCol .a-price .a-offscreen", ".a-price .a-offscreen",
  "[itemprop=price]", "[data-price]", "[data-testid*=price]", "[data-test*=price]", ".product-price", ".price--main", ".price-current", ".current-price", ".sales-price", ".pdp-price", ".price", "[class*=Price]", "[class*=price]",
];
function priceFromSelectors($: cheerio.CheerioAPI): { price: number; text: string } | null {
  for (const sel of PRICE_SELECTORS) {
    const els = $(sel).toArray().slice(0, 25);
    for (const e of els) {
      const $e = $(e);
      const candidates = [$e.attr("content"), $e.attr("data-price"), $e.text()].filter((t): t is string => !!t && /\d/.test(t) && t.trim().length <= 40);
      for (const t of candidates) { const p = parseMoney(t); if (p != null && p >= 0.5 && p < 100000) return { price: p, text: t }; }
    }
  }
  return null;
}

export function extractProduct(url: string, html: string, pageTitle = ""): Extracted | null {
  const $ = cheerio.load(html);
  const title = pageTitle || $("title").first().text().trim();
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const tld = host.split(".").pop() ?? "";

  // 1. ld+json Product / ProductGroup
  const nodes: LdNode[] = [];
  $('script[type="application/ld+json"]').each((_, e) => { try { walk(JSON.parse($(e).text()), nodes); } catch { /* skip malformed */ } });
  const ld = nodes.find((n) => isType(n, "Product") && firstOffer(n)) ?? nodes.find((n) => isType(n, "Product")) ?? null;

  let source = "";
  let name: string | null = null, brand: string | null = null, price: number | null = null, currency: string | null = null, inStock: boolean | null = null;
  const identifiers: CanonicalProduct["identifiers"] = {};

  if (ld) {
    source = "ld+json";
    name = str(ld.name);
    brand = str(ld.brand);
    const sku = str(ld.sku), mpn = str(ld.mpn);
    const gtin = str(ld.gtin13) ?? str(ld.gtin14) ?? str(ld.gtin8) ?? str(ld.gtin) ?? str(ld.gtin12);
    if (gtin) identifiers.gtin = gtin;
    if (sku) identifiers.sku = sku;
    if (mpn) identifiers.model = mpn;
    const off = firstOffer(ld);
    if (off) {
      price = parseMoney(off.price ?? off.lowPrice);
      currency = str(off.priceCurrency);
      const av = str(off.availability) ?? "";
      if (/InStock|LimitedAvailability|OnlineOnly/i.test(av)) inStock = true;
      else if (/OutOfStock|SoldOut|Discontinued|PreOrder|BackOrder/i.test(av)) inStock = false;
    }
  }

  // 2. Open Graph / product meta
  const meta = (sel: string) => $(sel).first().attr("content")?.trim() || null;
  if (!name) { name = meta('meta[property="og:title"]') ?? meta('meta[name="twitter:title"]'); if (name) source ||= "meta"; }
  if (price == null) { const p = parseMoney(meta('meta[property="product:price:amount"]') ?? meta('meta[property="og:price:amount"]') ?? meta('meta[itemprop="price"]') ?? $('[itemprop="price"]').first().attr("content") ?? null); if (p != null) { price = p; source ||= "meta"; } }
  if (!currency) currency = meta('meta[property="product:price:currency"]') ?? meta('meta[property="og:price:currency"]') ?? meta('meta[itemprop="priceCurrency"]') ?? $('[itemprop="priceCurrency"]').first().attr("content") ?? null;
  if (inStock == null) { const av = meta('meta[property="og:availability"]') ?? meta('meta[property="product:availability"]'); if (av) inStock = /instock|in stock|available/i.test(av); }
  if (!brand) brand = meta('meta[property="product:brand"]') ?? meta('meta[property="og:brand"]') ?? ($('[itemprop="brand"]').first().text().trim() || null);

  // 3. Common retailer selectors (Amazon, generic themes)
  if (!name) { for (const sel of ["#productTitle", "h1[itemprop=name]", "[data-testid=product-title]", ".product-title h1", ".product-name h1", "h1.product-title", "h1"]) { const t = $(sel).first().text().replace(/\s+/g, " ").trim(); if (t && t.length > 3) { name = t; source ||= "page"; break; } } }
  if (price == null) { const found = priceFromSelectors($); if (found) { price = found.price; source ||= "page"; const sym = Object.keys(SYMBOL_CURRENCY).find((s) => found.text.includes(s)); if (!currency && sym) currency = SYMBOL_CURRENCY[sym]; } }

  // Visible prose only (scripts and styles carry stray "$" and "in stock" strings)
  $("script, style, noscript, template").remove();
  const body = $("body").text().replace(/\s+/g, " ").toLowerCase();
  if (price == null) {
    const m = body.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)\s?(€|£|\$)|(€|£|\$)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/);
    if (m) { const p = parseMoney(m[1] ?? m[4]); if (p != null && p >= 0.5 && p < 100000) { price = p; source ||= "page"; if (!currency) currency = SYMBOL_CURRENCY[m[2] ?? m[3]] ?? null; } }
  }
  const cartSignal = /\b(add to cart|add to basket|add to bag|añadir a la cesta|añadir al carrito|comprar ahora|buy now|in stock|en stock|out of stock|sold out|agotado|sin stock|notify me|avísame)\b/.test(body);

  // 4. Title fallback — only when the page shows some sign of being a product page
  if (!name && title && (price != null || cartSignal || $('[itemprop="price"], [class*="add-to-cart"], [id*="add-to-cart"], button[name="add"]').length > 0)) { name = title.split(/\s+[|\-–—:]\s+/)[0].trim() || title; source ||= "title"; }
  if (!name) return null;

  // Strip the retailer's own name from the product name ("GAME.es - ps5 digital slim", "… | MediaMarkt")
  const site = host.split(".").slice(-2, -1)[0];
  if (site) {
    name = name.replace(new RegExp(`^\\s*${site}(?:\\.[a-z]{2,3})?\\s*[|\\-–—:]+\\s*`, "i"), "").replace(new RegExp(`\\s*[|\\-–—:]+\\s*[^|\\-–—:]*\\b${site}\\b[^|\\-–—:]*$`, "i"), "").trim() || name;
  }
  if (inStock == null) {
    if (/\b(out of stock|sold out|currently unavailable|temporarily out of stock|agotado|sin stock|no disponible|notify me|avísame|próximamente|coming soon)\b/.test(body)) inStock = false;
    else if (/\b(add to cart|add to basket|add to bag|añadir a la cesta|añadir al carrito|comprar ahora|buy now|in stock|en stock)\b/.test(body)) inStock = true;
    else inStock = false;
  }
  if (!currency) {
    const counts = Object.entries({ "€": (body.match(/€/g) ?? []).length, "£": (body.match(/£/g) ?? []).length, "$": (body.match(/\$/g) ?? []).length }).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    currency = counts.length ? SYMBOL_CURRENCY[counts[0][0]] : (TLD_CURRENCY[tld] ?? null);
  }

  const clean = name.replace(/\s+/g, " ").replace(/\b(comprar|buy)\b.*$/i, "").trim().slice(0, 120);
  const hay = `${clean} ${url} ${title}`;
  const category = guessCategory(hay);
  const { attributes, controls } = controlsFor(category, hay);
  if (!brand) { const b = hay.match(/\b(sony|nike|adidas|apple|samsung|nvidia|asus|msi|lego|microsoft|nintendo|new balance|puma|xiaomi|dell|hp|lenovo|garmin)\b/i); brand = b ? b[1] : null; }

  return {
    product: { name: clean, category, brand, identifiers, attributes, listed_price: price, currency: currency ? currency.toUpperCase() : null, in_stock: inStock },
    controls, source, page_title: title,
  };
}
