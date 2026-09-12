// A public, read-only product fixture. Restock is controlled by a local file, never HTTP.
import { createServer } from 'node:http';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const stateFile = resolve(process.env.RESTOCK_STATE ?? 'private-handoff/restock.json');
const logFile = resolve(process.env.RESTOCK_LOG ?? 'private-handoff/store-requests.jsonl');
mkdirSync(dirname(stateFile), { recursive: true });
mkdirSync(dirname(logFile), { recursive: true });
const host = process.env.RESTOCK_HOST ?? '127.0.0.1';
const port = Number(process.env.RESTOCK_PORT ?? 4011);
const product = (available) => ({
  '@context': 'https://schema.org', '@type': 'Product',
  name: 'Sony PlayStation 5 Slim Digital Edition 1TB', brand: { '@type': 'Brand', name: 'Sony' }, model: 'CFI-2016B', sku: 'CFI-2016B',
  additionalProperty: [{ '@type': 'PropertyValue', name: 'edition', value: 'digital' }, { '@type': 'PropertyValue', name: 'storage', value: '1tb' }],
  offers: { '@type': 'Offer', price: '248.00', priceCurrency: 'EUR', availability: `https://schema.org/${available ? 'InStock' : 'OutOfStock'}`, itemCondition: 'https://schema.org/NewCondition', shippingDetails: { '@type': 'OfferShippingDetails', shippingRate: { '@type': 'MonetaryAmount', value: '0.00', currency: 'EUR' } } }
});
createServer((req, res) => {
  const path = new URL(req.url, 'http://fixture.local').pathname;
  if (!['/products/ps5-slim', '/robots.txt'].includes(path)) { res.writeHead(404); res.end('Not found'); return; }
  if (path === '/robots.txt') { res.end('User-agent: *\nAllow: /products/ps5-slim\n'); return; }
  const available = existsSync(stateFile) && JSON.parse(readFileSync(stateFile, 'utf8')).in_stock === true;
  appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), path, available, user_agent: req.headers['user-agent'] ?? '', method: req.method }) + '\n');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sony PlayStation 5 Slim Digital Edition 1TB | Compralo Test Store</title><script type="application/ld+json">${JSON.stringify(product(available))}</script><style>body{font:18px/1.6 system-ui;background:#f3f0e9;color:#17202c;max-width:850px;margin:60px auto;padding:24px}main{background:white;border-radius:20px;padding:44px}.console{font-size:120px;text-align:center;background:#eef2fb;border-radius:16px;margin:24px 0}small{color:#576574}h1{line-height:1.2}strong{font-size:30px}.stock{font-size:22px;color:${available ? '#137b45' : '#a33333'}}button{padding:14px 24px;background:#18263d;color:white;border:0;border-radius:9px}</style></head><body><small>COMPRALO TEST STORE · STRIPE TEST / ZINC SANDBOX</small><main><div class="console">🎮</div><h1>Sony PlayStation 5 Slim Digital Edition 1TB</h1><p>Model CFI-2016B · SKU CFI-2016B</p><p>Edition: digital · Storage: 1tb · Condition: new · No bundle</p><strong>€248.00</strong><p>Free delivery · Total delivered: €248.00</p><p class="stock">${available ? 'In stock' : 'Out of stock'}</p><button ${available ? '' : 'disabled'}>${available ? 'Available in test stock' : 'Sold out — set a buy order'}</button><p><small>One fixed variant. Use AutoBuy to authorize a test hold and watch this product. No real merchandise will ship.</small></p></main></body></html>`);
}).listen(port, host, () => console.log(`Read-only restock store on http://${host}:${port}/products/ps5-slim`));
