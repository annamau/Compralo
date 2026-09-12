import type { NormalisedOffer } from "../../shared/types.js";

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const money = (n: number) => n.toFixed(2);

/** What the dashboard needs about an offer, without the full canonical blob repeated per event. */
export function summary(o: NormalisedOffer) {
  return {
    id: o.id, retailer: o.retailer, listing_title: o.listing_title,
    price: o.price, shipping: o.shipping, total: o.total, currency: o.currency,
    condition: o.condition, in_stock: o.in_stock, is_bundle: o.is_bundle,
    attributes: o.canonical.attributes, canonical_name: o.canonical.name,
  };
}
