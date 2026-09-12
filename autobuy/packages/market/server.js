// Market simulator — three fake retailers, deterministic on stage.
// Zero dependencies. GET /offers, POST /checkout, POST /admin/offers, POST /admin/reset.
import { createServer } from "node:http";

const PORT = Number(process.env.MARKET_PORT ?? 4000);
const RETAILERS = ["store-a", "store-b", "store-c"];

// Seed: the same product at all three retailers, all out of stock.
const seed = () => new Map([
  ["seed-a", { id: "seed-a", retailer: "store-a", listing_title: "Sony PlayStation 5 Slim Digital Edition 1TB", price: 449, shipping: 0, currency: "EUR", condition: "new", in_stock: false, url: "https://store-a.example/ps5-slim-digital" }],
  ["seed-b", { id: "seed-b", retailer: "store-b", listing_title: "PS5 Slim Digital Edition Console 1TB", price: 445, shipping: 15, currency: "EUR", condition: "new", in_stock: false, url: "https://store-b.example/ps5-slim-digital" }],
  ["seed-c", { id: "seed-c", retailer: "store-c", listing_title: "PlayStation 5 Slim (Digital) 1TB", price: 448, shipping: 0, currency: "EUR", condition: "new", in_stock: false, url: "https://store-c.example/ps5-slim-digital" }],
].map(([k, v]) => [k, v]));

let listings = seed();

// `checkout_total` is an admin-only field: what the merchant will actually charge at
// checkout. It is stripped from GET /offers so the agent can only learn it by trying.
const publicView = (l) => { const { checkout_total, ...pub } = l; return pub; };

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" });
  res.end(JSON.stringify(body));
};
const readJson = (req) => new Promise((resolve, reject) => {
  let buf = ""; req.on("data", (c) => (buf += c)); req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
});
const log = (...a) => console.log(`[market ${new Date().toISOString().slice(11, 19)}]`, ...a);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    if (route === "GET /offers") {
      return json(res, 200, [...listings.values()].map(publicView));
    }
    if (route === "GET /retailers") {
      return json(res, 200, RETAILERS);
    }
    if (route === "POST /checkout") {
      const { offer_id, expected_total } = await readJson(req);
      const l = listings.get(offer_id);
      if (!l || !l.in_stock) { log(`checkout ${offer_id} → 404 (unknown or out of stock)`); return json(res, 404, { error: "offer not available" }); }
      const actual = Number((l.checkout_total ?? l.price + l.shipping).toFixed(2));
      if (Math.abs(actual - Number(expected_total)) > 0.005) {
        log(`checkout ${offer_id} → 409 expected ${expected_total} actual ${actual}`);
        return json(res, 409, { actual_total: actual });
      }
      l.in_stock = false; // one unit sold
      const merchant_order_id = `${l.retailer}-${Date.now().toString(36).toUpperCase()}`;
      log(`checkout ${offer_id} → 200 ${merchant_order_id} (${actual} ${l.currency})`);
      return json(res, 200, { merchant_order_id, total: actual, currency: l.currency });
    }
    if (route === "POST /admin/offers") {
      const o = await readJson(req);
      if (!o.id || !RETAILERS.includes(o.retailer)) return json(res, 400, { error: "need id and a known retailer" });
      const listing = { shipping: 0, currency: "EUR", condition: "new", in_stock: true, url: `https://${o.retailer}.example/${o.id}`, ...o };
      listings.set(listing.id, listing);
      log(`offer ${listing.id} @ ${listing.retailer}: "${listing.listing_title}" ${listing.price}+${listing.shipping} ${listing.currency} in_stock=${listing.in_stock}${listing.checkout_total != null ? ` (checkout_total=${listing.checkout_total})` : ""}`);
      return json(res, 200, publicView(listing));
    }
    if (route === "POST /admin/reset") {
      listings = seed(); log("reset → 3 seeded listings, all out of stock");
      return json(res, 200, { ok: true, listings: listings.size });
    }
    return json(res, 404, { error: `no route ${route}` });
  } catch (e) {
    log(`error on ${route}: ${e.message}`);
    return json(res, 400, { error: e.message });
  }
}).listen(PORT, () => log(`market simulator listening on :${PORT} (${RETAILERS.join(", ")})`));
