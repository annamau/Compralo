// Integration test: Rust crawls the page, rejects OOS, re-crawls after restock and buys once.
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../money/package.json', import.meta.url));
const Stripe = require('stripe');
assert(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'));
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const base = process.env.RUST_URL ?? 'http://localhost:8080';
const money = process.env.MONEY_URL ?? 'http://localhost:4243';
const url = process.env.PRODUCT_URL;
assert(url, 'PRODUCT_URL required');
const out = new URL('../../private-handoff/', import.meta.url);
mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function api(path, body, origin=base) {
 const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
 const data=await r.json(); if(!r.ok) throw new Error(`${path} ${r.status}: ${JSON.stringify(data)}`);return data;
}
writeFileSync(new URL('restock.json',out),JSON.stringify({in_stock:false}));
const page = await fetch(url);
assert(page.ok, 'product page must load');
const understanding = await api('/understand', {url, html: await page.text()}, process.env.AI_URL ?? 'http://localhost:3002');
writeFileSync(new URL('understanding.json',out), JSON.stringify(understanding,null,2));
assert.equal(understanding.mode,'openrouter');assert.equal(understanding.product.in_stock,false);assert.equal(understanding.product.listed_price,248);
writeFileSync(new URL('restock.json',out),JSON.stringify({in_stock:false}));
const p=understanding.product;
const monitor=await api('/v1/monitors',{url,product:{name:p.name,brand:p.brand,model:p.identifiers.model??null,identifiers:p.identifiers},constraints:{maximum_total_minor:25000,currency:'EUR',condition:'new',variants:{edition:'digital',storage:'1tb'},bundles_allowed:false,approved_retailers:[new URL(url).hostname]},deadline:new Date(Date.now()+86400000).toISOString(),check_interval_seconds:10});
writeFileSync(new URL('latest-monitor.json',out),JSON.stringify(monitor,null,2));
console.log('MONITOR_CREATED',monitor.id);
const auth=await api(`/v1/monitors/${monitor.id}/payment-authorizations`,{maximum_minor:25000,currency:'EUR'});
assert(auth.hold_id.startsWith('pi_'));assert.equal(auth.status,'committed');
let pi=await stripe.paymentIntents.retrieve(auth.hold_id);assert.equal(pi.livemode,false);assert.equal(pi.status,'requires_capture');assert.equal(pi.amount_capturable,25000);
console.log('STRIPE_AUTHORIZED',auth.hold_id,'25000 EUR cents; captured=0');
let events=[];
const before=Date.now();
while(Date.now()-before<60000){events=await api(`/v1/monitors/${monitor.id}/events`);if(events.some(e=>e.kind==='offer_evaluated'&&e.payload.decision?.reasons?.includes('out_of_stock')))break;await sleep(1000);}
assert(events.some(e=>e.kind==='offer_observed'&&e.payload.offer.available===false),'must scrape OOS page');
assert(events.some(e=>e.kind==='offer_evaluated'&&e.payload.decision?.reasons?.includes('out_of_stock')),'must reject OOS');
assert.equal((await api(`/v1/monitors/${monitor.id}`)).status,'active');
console.log('OUT_OF_STOCK_REJECTED; monitor still active');
const restocked_at=new Date().toISOString();writeFileSync(new URL('restock.json',out),JSON.stringify({in_stock:true}));console.log('RESTOCKED',restocked_at);
let result;
const start=Date.now();
while(Date.now()-start<90000){result=await api(`/v1/monitors/${monitor.id}`);if(result.status==='purchased')break;await sleep(1000);}
events=await api(`/v1/monitors/${monitor.id}/events`);
writeFileSync(new URL('rust-events.json',out),JSON.stringify(events,null,2));
assert.equal(result.status,'purchased',JSON.stringify(events.slice(-5)));
assert(events.some(e=>e.kind==='offer_observed'&&e.payload.offer.available===true));
assert.equal(events.filter(e=>e.kind==='purchase_confirmed').length,1);
const purchase=await api(`/purchases/${encodeURIComponent('monitor:'+monitor.id)}`,undefined,money);
pi=await stripe.paymentIntents.retrieve(auth.hold_id);
assert.equal(pi.status,'succeeded');assert.equal(pi.amount_received,24800);assert.equal(pi.amount_capturable,0);
assert(purchase.zinc_order_id,'must have a Zinc sandbox order');
const zr=await fetch(`https://api.zinc.com/orders/${purchase.zinc_order_id}`,{headers:{authorization:`Bearer ${process.env.ZINC_API_KEY}`}});
const zinc=await zr.json();assert.equal(zinc.status,'order_placed');
const report={test:'Rust URL restock -> Stripe capture -> Zinc sandbox',passed:true,monitor_id:monitor.id,product_url:url,restocked_at,completed_at:new Date().toISOString(),ai:understanding.usage,authorization:{id:auth.hold_id,authorized_minor:25000},stripe:{livemode:pi.livemode,status:pi.status,amount_received:pi.amount_received,amount_capturable:pi.amount_capturable,currency:pi.currency},zinc:{id:purchase.zinc_order_id,status:zinc.status},purchase,events};
writeFileSync(new URL('RESTOCK-RESULT.json',out),JSON.stringify(report,null,2));
console.log('PASS',JSON.stringify({monitor_id:monitor.id,stripe_status:pi.status,captured_minor:pi.amount_received,zinc_id:purchase.zinc_order_id,zinc_status:zinc.status}));
