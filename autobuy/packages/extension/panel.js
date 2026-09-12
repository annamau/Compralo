// AutoBuy side panel. Reads the active tab (DOM + a screenshot), asks the backend to understand it,
// renders the product-specific controls, and creates the buy order. No model calls happen here.
const API = "http://localhost:3000";
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => { const n = Object.assign(document.createElement(tag), props); n.append(...children.filter((c) => c !== null && c !== undefined && c !== "")); return n; };
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);
const status = (text, kind = "") => { const s = $("status"); s.className = `status ${kind}`; s.textContent = text; show("status", !!text); };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

let product = null, seq = 0, timer = null, lastReadUrl = "", lastReadAt = 0;
const retriedFor = new Set();

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

async function readPage(force = false) {
  const tab = await activeTab();
  if (!tab?.id) { status("No active tab.", "error"); return; }
  if (!force && tab.url && tab.url === lastReadUrl && Date.now() - lastReadAt < 4000) return; // same page, just read
  if (tab.url && (tab.url.startsWith(API) || !/^https?:/.test(tab.url))) {                    // our own dashboard, chrome://, new tab…
    lastReadUrl = tab.url; lastReadAt = Date.now();
    show("product", false); show("order", false); show("result", false);
    status(tab.url.startsWith(API) ? "This is the AutoBuy dashboard. Open a product page and the panel will read it." : "Open a product page (http or https) and the panel will read it.");
    return;
  }
  const my = ++seq;
  lastReadUrl = tab.url ?? ""; lastReadAt = Date.now();
  status(`Reading ${tab.url ? hostOf(tab.url) : "this page"}…`, "skeleton");
  show("product", false); show("order", false); show("result", false);
  try {
    const [{ result: page }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ url: location.href, title: document.title, html: document.documentElement.outerHTML }),
    });
    let screenshot = null;
    try { screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 }); } catch (e) { console.warn("screenshot unavailable:", e?.message); }
    let res;
    try {
      res = await fetch(`${API}/understand`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...page, screenshot }) });
    } catch (e) { throw new Error(`${e.message} — is the backend running on ${API}?`); }
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { error: text }; }
    if (!res.ok) throw new Error(`${res.status}: ${body.error ?? text}`);   // backend error, verbatim
    if (my !== seq) return;                                                 // a newer read superseded this one
    product = body.product;
    renderProduct(body, page, screenshot);
    await renderForm(body.controls ?? []);
    status("");
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
  const how = body.mode === "claude"
    ? `Read by claude-opus-5${body.usage ? ` · ${body.usage.input_tokens + body.usage.output_tokens} tokens · $${body.usage.usd.toFixed(3)}` : ""}`
    : body.mode === "extracted" ? `Read locally from ${body.source} — no ANTHROPIC_API_KEY, so no AI reading`
    : "Fixture — the page could not be read and the backend has no ANTHROPIC_API_KEY";
  $("product").replaceChildren(
    screenshot ? el("img", { className: "shot", src: screenshot, alt: "what the agent saw", title: "Screenshot of the tab as it was read" }) : null,
    el("div", { className: "page", textContent: `${hostOf(page.url)} · ${page.title || page.url}` }),
    el("div", { className: "eyebrow", textContent: [p.brand, p.category].filter(Boolean).join(" · ") }),
    el("h1", { textContent: p.name }),
    el("div", { className: "meta" }, el("span", { className: `pill ${p.in_stock ? "ok" : "bad"}`, textContent: p.in_stock ? "in stock" : "out of stock" }), el("span", { textContent: price })),
    ids ? el("div", { className: "ids", textContent: ids }) : null,
    el("div", { className: "chips" }, ...Object.entries(p.attributes ?? {}).map(([k, v]) => el("span", { className: "chip", textContent: `${k}: ${v}` }))),
    el("div", { className: "mode", textContent: how }),
  );
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
  const retailers = await fetch(`${API}/retailers`).then((r) => r.json()).catch(() => ["store-a", "store-b", "store-c"]);
  $("retailers").replaceChildren(...retailers.map((r) => el("label", { className: "check" }, el("input", { type: "checkbox", value: r, checked: true }), el("span", { textContent: r }))));
  show("order");
}

$("order").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = $("create"); btn.disabled = true; btn.textContent = "Authorising hold…";
  const days = Number($("deadline_days").value || 30);
  const constraints = {
    max_total: Number($("max_total").value), currency: product.currency ?? "EUR", quantity: 1,
    condition: $("condition").value,
    approved_retailers: [...$("retailers").querySelectorAll("input:checked")].map((i) => i.value),
    deadline: new Date(Date.now() + days * 864e5).toISOString(),
    variant: readVariant(), allow_bundles: $("allow_bundles").checked,
  };
  try {
    const res = await fetch(`${API}/instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product, constraints, payment_method: $("payment_method").value }) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { error: text }; }
    if (!res.ok) throw new Error(`${res.status}: ${body.error ?? text}`);
    status("");
    renderResult(body);
  } catch (e) {
    status(String(e?.message ?? e), "error");
  } finally {
    btn.disabled = false; btn.textContent = "Create Buy Order";
  }
});

function renderResult(i) {
  const ok = i.status === "ACTIVE";
  const c = i.constraints;
  $("result").replaceChildren(
    el("span", { className: `pill ${ok ? "ok" : "warn"}`, textContent: i.status.replace("_", " ") }),
    el("h1", { textContent: ok ? "Buy order is live" : "Needs your attention" }),
    el("p", { textContent: ok
      ? `Watching ${c.approved_retailers.join(", ")} for ${i.product.name} at ≤ ${c.max_total.toFixed(2)} ${c.currency} until ${c.deadline.slice(0, 10)}. You can quit Chrome — the agent keeps polling.`
      : `Stripe returned ${i.status === "NEEDS_ATTENTION" ? "requires_action (3DS challenge)" : i.status}. Nothing will be bought until it is resolved.` }),
    el("div", { className: "ids", textContent: `instruction ${i.id}` }),
    el("div", { className: "ids", textContent: `stripe ${i.stripe_payment_intent ?? "—"}` }),
    el("a", { className: "button", href: `${API}/dashboard`, target: "_blank", rel: "noopener", textContent: "Open dashboard ↗" }),
  );
  show("result");
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- Re-read triggers: the button, tab switches, navigations (full loads and SPA URL changes),
// and a 1.5 s URL poll as a fallback for sites whose navigations fire no tab events.
const scheduleRead = () => { clearTimeout(timer); timer = setTimeout(() => readPage(false), 400); };
$("reread").addEventListener("click", () => readPage(true));
chrome.tabs.onActivated.addListener(scheduleRead);
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && (info.status === "complete" || info.url)) scheduleRead(); });
setInterval(async () => { const t = await activeTab(); if (t?.url && t.status === "complete" && t.url !== lastReadUrl) scheduleRead(); }, 1500);
readPage(true);
