import "./env.js"; // must be first: loads .env before stripe.ts / ai.ts read process.env
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { BACKEND_DIR, MARKET_URL, PORT } from "./env.js";
import { load, persist, reset, state } from "./state.js";
import { emit, eventsFor, subscribe, subscriberCount } from "./events.js";
import { AI_MODE, cacheSize, resetAiCache, understand } from "./ai.js";
import { STRIPE_MODE, authorise } from "./stripe.js";
import { fetchRetailers } from "./market.js";
import { startExaMonitor, startMonitor } from "./monitor.js";
import { perception } from "./perception.js";
import { money } from "./util.js";
import type { CanonicalProduct, Constraints, Instruction } from "../../shared/types.js";

const app = new Hono();
app.use("*", cors());
app.route("/", perception);   // POST /discover, POST /adjudicate — the Exa perception lane

// ---- AI: understand the page the user is on -------------------------------------------------
app.post("/understand", async (c) => {
  let body: { url?: string; html?: string; title?: string; screenshot?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "body must be JSON { url, html }" }, 400); }
  if (!body.url || !body.html) return c.json({ error: "need { url, html }" }, 400);
  const t0 = Date.now();
  try {
    const shot = typeof body.screenshot === "string" && body.screenshot.startsWith("data:image/") && body.screenshot.length < 6_000_000 ? body.screenshot : undefined;
    const r = await understand(body.url, body.html, body.title ?? "", shot);
    console.log(`[understand] ${r.mode}${r.source ? `/${r.source}` : ""} ${body.url.slice(0, 80)} → "${r.product.name}" ${r.product.listed_price ?? "?"} ${r.product.currency ?? ""} ${r.product.in_stock ? "in stock" : "out of stock"} (${r.controls.length} controls, ${Math.round(body.html.length / 1024)} KB html${shot ? `, ${Math.round(shot.length / 1024)} KB screenshot` : ""}, ${Date.now() - t0} ms${r.usage ? `, ${r.usage.input_tokens}+${r.usage.output_tokens} tokens, $${r.usage.usd.toFixed(4)}` : ""})`);
    return c.json({ product: r.product, controls: r.controls, mode: r.mode, source: r.source ?? null, page_title: r.page_title ?? null, usage: r.usage ?? null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[understand] failed after ${Date.now() - t0} ms: ${msg}`);
    return c.json({ error: msg }, 500);
  }
});

// ---- Instructions -----------------------------------------------------------------------------
const CONDITIONS = new Set(["new", "refurbished", "any"]);

function validateConstraints(x: Partial<Constraints> | undefined): string | null {
  if (!x || typeof x !== "object") return "constraints missing";
  if (typeof x.max_total !== "number" || !(x.max_total > 0)) return "constraints.max_total must be a positive number";
  if (typeof x.currency !== "string" || x.currency.length !== 3) return "constraints.currency must be a 3-letter code";
  if (!CONDITIONS.has(String(x.condition))) return "constraints.condition must be new | refurbished | any";
  if (!Array.isArray(x.approved_retailers) || x.approved_retailers.length === 0) return "constraints.approved_retailers must be a non-empty array";
  if (typeof x.deadline !== "string" || !Number.isFinite(Date.parse(x.deadline))) return "constraints.deadline must be an ISO date";
  if (Date.parse(x.deadline) < Date.now()) return "constraints.deadline is in the past";
  if (typeof x.allow_bundles !== "boolean") return "constraints.allow_bundles must be boolean";
  if (x.variant && typeof x.variant !== "object") return "constraints.variant must be an object";
  return null;
}

app.post("/instructions", async (c) => {
  let body: { product?: CanonicalProduct; constraints?: Constraints; payment_method?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "body must be JSON { product, constraints }" }, 400); }
  if (!body.product || typeof body.product.name !== "string") return c.json({ error: "product missing" }, 400);
  const problem = validateConstraints(body.constraints);
  if (problem) return c.json({ error: problem }, 400);
  const constraints: Constraints = { ...(body.constraints as Constraints), quantity: 1, variant: body.constraints?.variant ?? {}, currency: body.constraints!.currency.toUpperCase() };
  const payment_method = body.payment_method || "pm_card_visa";

  let auth;
  try {
    auth = await authorise(body.product, constraints, payment_method);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[instructions] Stripe authorisation failed: ${msg}`);
    return c.json({ error: `Stripe authorisation failed: ${msg}` }, 502);
  }

  const id = randomUUID();
  const status: Instruction["status"] = auth.status === "requires_capture" ? "ACTIVE" : "NEEDS_ATTENTION";
  const instruction: Instruction = { id, product: body.product, constraints, status, stripe_payment_intent: auth.id, order: null, created_at: new Date().toISOString() };
  state.instructions.set(id, instruction);
  persist();

  if (status === "ACTIVE") {
    emit(id, "CREATED", `mandate: ${body.product.name} ≤ ${money(constraints.max_total)} ${constraints.currency}, ${constraints.condition}, ${constraints.allow_bundles ? "bundles ok" : "no bundles"}, ${Object.entries(constraints.variant).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : v}`).join(" ") || "no variant rules"}, retailers [${constraints.approved_retailers.join(", ")}], until ${constraints.deadline.slice(0, 10)}; hold ${auth.id} (${STRIPE_MODE})`, { constraints, payment_intent: auth.id, payment_status: auth.status });
  } else if (auth.status === "requires_action") {
    emit(id, "PAYMENT_ACTION_REQUIRED", `card needs authentication (3DS): ${auth.id} is ${auth.status} — not monitoring until the customer completes it`, { payment_intent: auth.id, payment_status: auth.status });
  } else {
    emit(id, "FAILED", `unexpected payment status ${auth.status} on ${auth.id} — needs attention`, { payment_intent: auth.id, payment_status: auth.status });
  }
  return c.json(instruction, 201);
});

app.get("/instructions", (c) => c.json([...state.instructions.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))));
app.get("/instructions/:id", (c) => {
  const i = state.instructions.get(c.req.param("id"));
  return i ? c.json(i) : c.json({ error: "not found" }, 404);
});

// ---- Events -----------------------------------------------------------------------------------
app.get("/events", (c) => {
  const id = c.req.query("instruction_id");
  return c.json(id ? eventsFor(id) : state.events);
});

app.get("/events/stream", (c) =>
  streamSSE(c, async (stream) => {
    let open = true;
    const unsubscribe = subscribe((e) => { void stream.writeSSE({ data: JSON.stringify(e), id: e.at }).catch(() => {}); });
    stream.onAbort(() => { open = false; unsubscribe(); });
    await stream.writeSSE({ event: "hello", data: JSON.stringify({ instructions: state.instructions.size, events: state.events.length, ai: AI_MODE, stripe: STRIPE_MODE }) });
    while (open) {
      await stream.sleep(15000);
      if (open) await stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => { open = false; });
    }
  }),
);

// ---- Dashboard & helpers ----------------------------------------------------------------------
app.get("/", (c) => c.redirect("/dashboard"));
app.get("/dashboard", (c) => c.html(readFileSync(resolve(BACKEND_DIR, "dashboard.html"), "utf8")));
app.get("/retailers", async (c) => c.json(await fetchRetailers()));
app.get("/usage", (c) => c.json({ ai: AI_MODE, stripe: STRIPE_MODE, ...state.usage, total_usd: Object.values(state.usage).reduce((sum, b) => sum + (b?.usd ?? 0), 0), normalise_cache: cacheSize() }));
app.get("/health", (c) => c.json({ ok: true, ai: AI_MODE, stripe: STRIPE_MODE, market: MARKET_URL, instructions: state.instructions.size, events: state.events.length, sse_clients: subscriberCount() }));
app.post("/admin/reset", (c) => { reset(); resetAiCache(); console.log("[admin] state reset: 0 instructions, 0 events, cache cleared"); return c.json({ ok: true }); });

// ---- Boot -------------------------------------------------------------------------------------
load();
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`AutoBuy backend  http://localhost:${PORT}   dashboard → http://localhost:${PORT}/dashboard`);
  console.log(`AI:      ${AI_MODE === "claude" ? "claude-opus-5 (understand + normalise)" : "hardcoded fixtures — set ANTHROPIC_API_KEY in packages/backend/.env for real page understanding"}`);
  console.log(`Stripe:  ${STRIPE_MODE === "test" ? "test mode, manual capture" : "STUB — set STRIPE_SECRET_KEY=sk_test_… in packages/backend/.env for a real test-mode hold"}`);
  console.log(`Market:  ${MARKET_URL}`);
  startMonitor();
  startExaMonitor();
});
