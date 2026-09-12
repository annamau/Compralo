// packages/shared/types.ts — the one contract all three packages share.

export type CanonicalProduct = {
  name: string;                       // "PlayStation 5 Slim Digital Edition 1TB"
  category: string;                   // "games_console" | "footwear" | "gpu" | ...
  brand: string | null;
  identifiers: { gtin?: string; ean?: string; sku?: string; model?: string };
  attributes: Record<string, string>; // { edition: "digital", storage: "1TB" }
  listed_price: number | null;
  currency: string | null;
  in_stock: boolean;
};

export type Control = {
  key: string;                        // "edition"
  label: string;                      // "Edition"
  type: "select" | "multiselect" | "number" | "boolean";
  options?: string[];                 // for select/multiselect
  default: string | string[] | number | boolean;
  required_match: boolean;            // true → offer.attributes[key] must equal the chosen value
};

export type Constraints = {
  max_total: number;                  // delivered price ceiling, in currency
  currency: string;
  quantity: 1;                        // fairness rule: hard-coded to 1
  condition: "new" | "refurbished" | "any";
  approved_retailers: string[];
  deadline: string;                   // ISO date
  variant: Record<string, string | string[]>;  // chosen values keyed by Control.key
  allow_bundles: boolean;
};

export type InstructionStatus =
  | "ACTIVE" | "EVALUATING" | "EXECUTING" | "PURCHASED"
  | "NEEDS_ATTENTION" | "FAILED" | "EXPIRED" | "CANCELLED";

export type Instruction = {
  id: string;
  product: CanonicalProduct;
  constraints: Constraints;
  status: InstructionStatus;
  stripe_payment_intent: string | null;
  order: { retailer: string; total: number; merchant_order_id: string; at: string } | null;
  created_at: string;
};

export type RawOffer = {              // what the market emits — deliberately unstructured
  id: string; retailer: string; listing_title: string; price: number; shipping: number;
  currency: string; condition: string; in_stock: boolean; url: string;
};

export type NormalisedOffer = RawOffer & {
  canonical: CanonicalProduct;        // Claude's reading of the listing, cached by offer.id
  is_bundle: boolean;
  total: number;                      // price + shipping
};

export type Check = { name: string; pass: boolean; detail: string };
export type Evaluation = { qualified: boolean; checks: Check[] };

export type EventType =
  | "CREATED" | "OFFER_SEEN" | "OFFER_NORMALISED" | "OFFER_REJECTED" | "OFFER_QUALIFIED"
  | "LOCK_ACQUIRED" | "REVALIDATED" | "PAYMENT_CAPTURED" | "CHECKOUT_OK" | "PURCHASED"
  | "CHECKOUT_PRICE_MISMATCH" | "PAYMENT_ACTION_REQUIRED" | "FAILED";

export type Event = {
  at: string; instruction_id: string;
  type: EventType;
  detail: string; data?: unknown;
};
