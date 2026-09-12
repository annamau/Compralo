// Hardcoded stand-ins used when ANTHROPIC_API_KEY is unset (and for the hour-one checkpoint).
import type { CanonicalProduct, Control, RawOffer } from "../../shared/types.js";

export type Understanding = { product: CanonicalProduct; controls: Control[] };

export const PS5: Understanding = {
  product: {
    name: "Sony PlayStation 5 Slim Digital Edition 1TB",
    category: "games_console",
    brand: "Sony",
    identifiers: { model: "CFI-2016" },
    attributes: { edition: "digital", storage: "1TB", colour: "white" },
    listed_price: 449.99,
    currency: "EUR",
    in_stock: false,
  },
  controls: [
    { key: "edition", label: "Edition", type: "select", options: ["digital", "disc"], default: "digital", required_match: true },
    { key: "storage", label: "Storage", type: "select", options: ["1TB", "2TB"], default: "1TB", required_match: true },
    { key: "colour", label: "Colour", type: "select", options: ["white", "black"], default: "white", required_match: false },
  ],
};

export const SHOE: Understanding = {
  product: {
    name: "Nike Air Max 90",
    category: "footwear",
    brand: "Nike",
    identifiers: { sku: "CN8490-100" },
    attributes: { size: "42", colour: "white", width: "regular" },
    listed_price: 149.99,
    currency: "EUR",
    in_stock: false,
  },
  controls: [
    { key: "size", label: "Size (EU)", type: "multiselect", options: ["40", "41", "42", "43", "44", "45", "46"], default: ["42"], required_match: true },
    { key: "colour", label: "Colour", type: "select", options: ["white", "black", "grey"], default: "white", required_match: true },
    { key: "width", label: "Width", type: "select", options: ["regular", "wide"], default: "regular", required_match: false },
  ],
};

export function fixtureFor(url: string, title: string): Understanding {
  const t = `${url} ${title}`.toLowerCase();
  if (/(nike|adidas|shoe|sneaker|trainer|zapatilla|footwear|boot|air max|jordan)/.test(t)) return SHOE;
  return PS5;
}

/** Deterministic stand-in for Claude's listing normalisation. Keyword rules only. */
export function heuristicNormalise(raw: RawOffer, target: CanonicalProduct): { canonical: CanonicalProduct; is_bundle: boolean } {
  const t = raw.listing_title.toLowerCase();
  const is_bundle = /\bbundle\b|\+|\bwith\b.*\b(game|controller|headset)\b/.test(t);
  const attributes: Record<string, string> = { ...target.attributes };
  if (/\bdisc\b|\bstandard edition\b/.test(t)) attributes.edition = "disc";
  else if (/\bdigital\b/.test(t)) attributes.edition = "digital";
  const storage = t.match(/(\d+)\s?tb\b/); if (storage) attributes.storage = `${storage[1]}TB`;
  const size = t.match(/\b(?:size|eu|uk)\s?(\d{2}(?:\.5)?)\b/); if (size && "size" in attributes) attributes.size = size[1];
  const colour = t.match(/\b(white|black|grey|gray|red|blue)\b/); if (colour && "colour" in attributes) attributes.colour = colour[1] === "gray" ? "grey" : colour[1];
  return {
    canonical: { ...target, name: raw.listing_title, attributes, listed_price: raw.price, currency: raw.currency, in_stock: raw.in_stock },
    is_bundle,
  };
}
