// AutoBuy side panel. Reads the active tab (DOM + a screenshot), asks the backend to understand it,
// renders the product-specific controls, and creates the buy order. No model calls happen here.
// The backend base URL is resolved from chrome.storage at boot (see config.js), so one build of
// this extension works against the laptop and the deployed box. Everything below reads API().
let API_BASE = DEFAULT_BACKEND_URL;
const API = () => API_BASE;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => { const n = Object.assign(document.createElement(tag), props); n.append(...children.filter((c) => c !== null && c !== undefined && c !== "")); return n; };
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);
const status = (text, kind = "") => { const s = $("status"); s.className = `status ${kind}`; s.textContent = text; show("status", !!text); };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

let product = null, sourceUrl = "", seq = 0, timer = null, lastReadUrl = "", lastReadAt = 0;
const retriedFor = new Set();

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

async function readPage(force = false) {
  const tab = await activeTab();
  if (!tab?.id) { ++seq; status("No active tab.", "error"); return; }
  if (!force && tab.url && tab.url === lastReadUrl && Date.now() - lastReadAt < 4000) return; // same page, just read
  if (tab.url && !/^https?:/.test(tab.url)) {                    // our own dashboard, chrome://, new tab…
    ++seq; lastReadUrl = tab.url; lastReadAt = Date.now();
    show("product", false); show("order", false); show("result", false); show("gift-card", false); show("watch-instead", false);
    status("Open a product page (http or https) and the panel will read it.");
    return;
  }
  const my = ++seq;
  lastReadUrl = tab.url ?? ""; lastReadAt = Date.now();
  status(`Reading ${tab.url ? hostOf(tab.url) : "this page"}…`, "skeleton");
  show("product", false); show("order", false); show("result", false); show("gift-card", false); show("watch-instead", false);
  try {
    const [{ result: page }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ url: location.href, title: document.title, html: document.documentElement.outerHTML }),
    });
    let screenshot = null;
    try { screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 }); } catch (e) { console.warn("screenshot unavailable:", e?.message); }
    let res;
    try {
      res = await fetch(`${await intelligenceUrl()}/understand`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...page, screenshot }) });
    } catch (e) { throw new Error(`${e.message} — is the backend running on ${API()}?`); }
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { error: text }; }
    if (!res.ok) throw new Error(`${res.status}: ${body.error ?? text}`);   // backend error, verbatim
    if (my !== seq) return;                                                 // a newer read superseded this one
    product = body.product;
    sourceUrl = page.url;
    await chrome.storage.local.set({ last_understanding: { at: new Date().toISOString(), url: page.url, mode: body.mode, usage: body.usage, product: body.product } });
    renderProduct(body, page, screenshot);
    await renderForm(body.controls ?? []);
    status("");
    show("order", false); show("watch-instead");
    await matchGiftCard(my);
    // Some shops paint the price after load; read once more a moment later if it was missing.
    if (product.listed_price == null && !retriedFor.has(page.url)) { retriedFor.add(page.url); setTimeout(() => readPage(true), 2500); }
  } catch (e) {
    if (my === seq) status(String(e?.message ?? e), "error");
  }
}

function renderProduct(body, page, screenshot) {
  const p = body.product;
  const ids = Object.entries(p.identifiers ?? {}).filter(([, v]) => v).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(" · ");
  const price = p.listed_price != null ? `${Number(p.listed_price).toFixed(2)} ${p.currency ?? ""}` : "no price shown";
  const how = ["claude", "openrouter"].includes(body.mode)
    ? `Read by ${body.usage?.model ?? body.mode}${body.usage ? ` · ${body.usage.input_tokens + body.usage.output_tokens} tokens · $${body.usage.usd.toFixed(3)}` : ""}`
    : body.mode === "extracted" ? `Read locally from ${body.source} — no ANTHROPIC_API_KEY, so no AI reading`
    : "Fixture — the page could not be read and the backend has no ANTHROPIC_API_KEY";
  $("product").replaceChildren(...[
    screenshot ? el("img", { className: "shot", src: screenshot, alt: "what the agent saw", title: "Screenshot of the tab as it was read" }) : null,
    el("div", { className: "page", textContent: `${hostOf(page.url)} · ${page.title || page.url}` }),
    el("div", { className: "eyebrow", textContent: [p.brand, p.category].filter(Boolean).join(" · ") }),
    el("h1", { textContent: p.name }),
    el("div", { className: "meta" }, el("span", { className: `pill ${p.in_stock ? "ok" : "bad"}`, textContent: p.in_stock ? "in stock" : "out of stock" }), el("span", { textContent: price })),
    ids ? el("div", { className: "ids", textContent: ids }) : null,
    el("div", { className: "chips" }, ...Object.entries(p.attributes ?? {}).map(([k, v]) => el("span", { className: "chip", textContent: `${k}: ${v}` }))),
    el("div", { className: "mode", textContent: how }),
  ].filter(Boolean));
  show("product");
}

// ---- the ~40-line control renderer: select / multiselect / number / boolean ----------------
const UNIVERSAL = new Set(["condition", "allow_bundles", "bundles", "bundle", "price", "max_total", "retailer", "retailers", "quantity", "deadline"]);

function renderControl(c) {
  const wrap = el("div", { className: "field control" });
  Object.assign(wrap.dataset, { key: c.key, type: c.type, required: String(!!c.required_match) });
  wrap.append(el("label", { textContent: c.label }, c.required_match ? el("span", { className: "req", textContent: " · must match" }) : null));
  const d = c.default;
  if (c.type === "select") {
    const s = el("select");
    for (const o of c.options ?? []) s.append(el("option", { value: o, textContent: o, selected: String(d) === String(o) }));
    wrap.append(s);
  } else if (c.type === "multiselect") {
    const defaults = (Array.isArray(d) ? d : [d]).map(String);
    const box = el("div", { className: "checks" });
    for (const o of c.options ?? []) box.append(el("label", { className: "check" }, el("input", { type: "checkbox", value: o, checked: defaults.includes(String(o)) }), el("span", { textContent: o })));
    wrap.append(box);
  } else if (c.type === "number") {
    wrap.append(el("input", { type: "number", value: d ?? "" }));
  } else {
    wrap.append(el("label", { className: "check" }, el("input", { type: "checkbox", checked: d === true || d === "true" }), el("span", { textContent: "yes" })));
  }
  return wrap;
}

function readVariant() {
  const v = {};
  for (const w of document.querySelectorAll("#controls .control")) {
    if (w.dataset.required !== "true") continue;          // preferences are shown but not enforced
    const t = w.dataset.type, k = w.dataset.key;
    if (t === "select") v[k] = w.querySelector("select").value;
    else if (t === "multiselect") v[k] = [...w.querySelectorAll("input:checked")].map((i) => i.value);
    else if (t === "number") v[k] = w.querySelector("input").value;
    else v[k] = String(w.querySelector("input").checked);
  }
  return v;
}

async function renderForm(controls) {
  $("controls").replaceChildren(...controls.filter((c) => !UNIVERSAL.has(String(c.key).toLowerCase())).map(renderControl));
  $("max_total").value = product.listed_price != null ? Math.ceil(Number(product.listed_price)) : "";
  $("currency").textContent = product.currency ?? "EUR";
  const retailers = [new URL(sourceUrl).hostname.replace(/^www\./, "")];
  $("retailers").replaceChildren(...retailers.map((r) => el("label", { className: "check" }, el("input", { type: "checkbox", value: r, checked: true }), el("span", { textContent: r }))));
  show("order");
}

$("watch-instead").addEventListener("click", () => show("order", $("order").classList.contains("hidden")));

$("order").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = $("create"); btn.disabled = true; btn.textContent = "Authorising hold…";
  const days = Number($("deadline_days").value || 7);
  try {
    const variants = readVariant();
    if (Object.values(variants).some((v) => Array.isArray(v) && v.length !== 1)) throw new Error("Select one value per variant for this Rust monitor.");
    const maxMinor = Math.round(Number($("max_total").value) * 100);
    if (!Number.isSafeInteger(maxMinor) || maxMinor <= 0 || days < 1 || days > 7) throw new Error("Choose a positive ceiling and a deadline of 1–7 days.");
    const payload = {
      url: sourceUrl,
      product: { name: product.name, brand: product.brand, model: product.identifiers?.model ?? null, identifiers: product.identifiers ?? {} },
      constraints: { maximum_total_minor: maxMinor, currency: product.currency ?? "EUR", condition: $("condition").value === "any" ? null : $("condition").value,
        approved_retailers: [...$("retailers").querySelectorAll("input:checked")].map((i) => i.value),
        variants: Object.fromEntries(Object.entries(variants).map(([k,v]) => [k, Array.isArray(v) ? v[0] : String(v)])), bundles_allowed: $("allow_bundles").checked },
      deadline: new Date(Date.now() + days * 864e5).toISOString(), check_interval_seconds: 10,
    };
    if (!payload.constraints.approved_retailers.length) throw new Error("Approve the retailer before creating a monitor.");
    const monitor = await rustRequest("/v1/monitors", payload);
    await chrome.storage.local.set({ last_monitor_id: monitor.id });
    show("order", false);
    try {
      const auth = await rustRequest(`/v1/monitors/${monitor.id}/payment-authorizations`, { maximum_minor: maxMinor, currency: payload.constraints.currency });
      await chrome.storage.local.set({ [`authorization_${monitor.id}`]: auth });
      renderRustResult(monitor, auth);
      status("");
    } catch (e) {
      renderRustResult(monitor, null);
      status(`Rust monitor ${monitor.id} was created, but authorization failed: ${e.message}. Check its dashboard before retrying.`, "error");
    }
  } catch (e) { status(String(e?.message ?? e), "error"); }
  finally { btn.disabled = false; btn.textContent = "Authorize and watch"; }
});

async function rustRequest(path, body) {
  API_BASE = await backendUrl();
  const response = await fetch(`${API()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { throw new Error(`Rust API ${response.status}: ${text || "empty response"}`); }
  if (!response.ok) throw new Error(data.error ?? `Rust API ${response.status}`);
  return data;
}

function renderRustResult(monitor, auth) {
  const stripe = auth?.hold_id?.startsWith("pi_");
  $("result").replaceChildren(
    el("span", { className: "pill ok", textContent: "Rust received monitor" }),
    el("h1", { textContent: "Rust is watching this link" }),
    el("p", { textContent: `${monitor.product.name} · ceiling ${(monitor.constraints.maximum_total_minor / 100).toFixed(2)} ${monitor.constraints.currency} · checks every ${monitor.check_interval_seconds} seconds` }),
    el("p", { textContent: stripe ? `Stripe ${auth.status}: ${auth.hold_id}` : auth ? "Demo authorization recorded. This server has not returned a Stripe hold." : "Payment authorization is not confirmed." }),
    el("div", { className: "ids", textContent: `monitor ${monitor.id}` }),
    el("a", { className: "button", href: chrome.runtime.getURL("dashboard.html"), target: "_blank", rel: "noopener", textContent: "Open dashboard ↗" }),
  );
  show("result");
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

// The article reader supplies context; the server pins retailer-to-card mappings and amounts.
let giftCsrf = '';
async function giftRequest(path, body) {
  const response = await fetch(`${API()}${path}`, {method:body?'POST':'GET', credentials:'include',
    headers:{'content-type':'application/json','x-csrf-token':giftCsrf}, ...(body?{body:JSON.stringify(body)}:{}), signal:AbortSignal.timeout(30000)});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Gift-card service is unavailable.');
  return value;
}
async function matchGiftCard(readSequence) {
  const root = $('gift-card'); root.replaceChildren(el('h2',{textContent:'Gift card for this article'}),el('p',{textContent:'Checking the retailer and card value…'})); show('gift-card');
  try {
    // Establish only a same-backend HttpOnly session. Provider credentials never enter the extension.
    await fetch(`${API()}/bitrefill`, {credentials:'include',signal:AbortSignal.timeout(30000)});
    const connection = await giftRequest('/v1/integrations/bitrefill/status');
    if (readSequence !== seq) return;
    giftCsrf = connection.csrf;
    if (!connection.connected) {
      root.replaceChildren(el('h2',{textContent:'Connect purchases once'}),el('p',{textContent:'Connect your Bitrefill account once. Product matching and reviews stay here in the extension.'}));
      const connect = el('button',{type:'button',className:'primary',textContent:'Connect purchase account'});
      connect.onclick=async()=>{connect.disabled=true;try {const auth=await giftRequest('/v1/integrations/bitrefill/oauth/start',{});await chrome.tabs.create({url:auth.url});}catch(e){status(e.message,'error');}finally{connect.disabled=false;}};
      const retry=el('button',{type:'button',className:'ghost',textContent:'I connected — check again'});retry.onclick=()=>matchGiftCard(seq);
      root.append(connect,retry);return;
    }
    const amount = Math.round(Number(product.listed_price)*100);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('A listed product price is needed to choose a matching card.');
    const result=await giftRequest('/v1/bitrefill/match',{url:sourceUrl,name:product.name,price_minor:amount,currency:product.currency,country:'ES'});
    if (readSequence !== seq) return;
    const q=result.quote;
    root.replaceChildren(el('h2',{textContent:'Your matching gift card'}),
      el('p',{textContent:`For ${q.article.name}`}),
      el('h3',{textContent:q.name}),
      el('p',{textContent:`Card value: ${q.face_value} ${q.face_currency} · catalog price: ${(q.catalog_total_minor/100).toFixed(2)} ${q.catalog_currency}`}),
      el('p',{textContent:`Covers the article’s listed ${(q.article.price_minor/100).toFixed(2)} ${q.article.currency}. Shipping and retailer exclusions must be checked separately.`}),
      el('p',{textContent:'You are buying a gift card. The store product is not ordered automatically.'}));
    const terms=el('details',{},el('summary',{textContent:'Redemption and restrictions'}));
    const plain=value=>new DOMParser().parseFromString(String(value||''),'text/html').body.textContent;
    terms.append(el('p',{textContent:plain(q.restrictions)}),el('p',{textContent:plain(q.instructions)}));root.append(terms);
    root.append(el('p',{className:'hint',textContent:result.checkout_note}),
      el('button',{type:'button',className:'primary',disabled:true,textContent:'Buy gift card — unavailable in this test'}));
  } catch(e) {if(readSequence===seq)root.replaceChildren(el('h2',{textContent:'Gift-card match unavailable'}),el('p',{textContent:e.message}));}
}

// ---- Backend setting. Resolved before the first read so the panel never calls the wrong host.
async function initBackend() {
  API_BASE = await backendUrl();
  $("backend_url").value = API_BASE === DEFAULT_BACKEND_URL ? "" : API_BASE;
  $("backend_url").placeholder = DEFAULT_BACKEND_URL;
  $("intelligence_url").value = (await chrome.storage.sync.get("intelligence_url")).intelligence_url ?? "";
  $("dash-link").href = chrome.runtime.getURL("dashboard.html");
  const known = KNOWN_BACKENDS.includes(API_BASE);
  $("backend_hint").textContent = known
    ? `Using ${API_BASE}.`
    : `Using ${API_BASE}. This build permits HTTP and HTTPS backends.`;
}
$("save_backend").addEventListener("click", async () => {
  API_BASE = await setBackendUrl($("backend_url").value);
  await chrome.storage.sync.set({ intelligence_url: $("intelligence_url").value.trim().replace(/\/+$/, "") });
  await initBackend();
  status(`Backend set to ${API_BASE}`, "");
  readPage(true);
});

// ---- Re-read triggers: the button, tab switches, navigations (full loads and SPA URL changes),
// and a 1.5 s URL poll as a fallback for sites whose navigations fire no tab events.
const scheduleRead = () => { clearTimeout(timer); timer = setTimeout(() => readPage(false), 400); };
$("reread").addEventListener("click", () => readPage(true));
chrome.tabs.onActivated.addListener(scheduleRead);
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && (info.status === "complete" || info.url)) scheduleRead(); });
setInterval(async () => { const t = await activeTab(); if (t?.url && t.status === "complete" && t.url !== lastReadUrl) scheduleRead(); }, 1500);
initBackend().then(() => readPage(true));
