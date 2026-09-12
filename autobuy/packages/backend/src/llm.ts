// One structured-output call, two providers behind it.
//
// The AI lane needs exactly one primitive: "here is a system prompt, a user turn and a Zod
// schema — give me back a value of that type, and tell me what it cost". Anthropic's
// messages.parse does that natively. OpenRouter's free models do it through the
// OpenAI-compatible chat-completions endpoint with response_format json_schema strict.
// Everything above this file (claude.ts, exa.ts) is written once against structured().
//
// Provider selection is by key, not by flag: an Anthropic key wins because it is the paid,
// better model; with only an OpenRouter key the whole lane runs free; with neither, "none"
// and callers fall back to fixtures.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { recordUsage, type Usage } from "./state.js";

export type Provider = "anthropic" | "openrouter" | "none";
export const PROVIDER: Provider =
  process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENROUTER_API_KEY ? "openrouter" : "none";

export const ANTHROPIC_MODEL = "claude-opus-5";

// Use Luna by default. Optional fallback must be configured explicitly so a demo
// does not silently switch back to a rate-limited free model.
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna";
export const OPENROUTER_MODEL_FALLBACK = process.env.OPENROUTER_MODEL_FALLBACK ?? "";
export const OPENROUTER_BASE_URL = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");

/** The model string shown at boot, on /health and on the dashboard. */
export const MODEL_LABEL =
  PROVIDER === "anthropic" ? ANTHROPIC_MODEL
  : PROVIDER === "openrouter" ? OPENROUTER_MODEL
  : "none";

export type UsageLine = {
  input_tokens: number; output_tokens: number;
  cache_write_tokens: number; cache_read_tokens: number;
  usd: number;
  model?: string;                 // which model actually answered — free models fail over
};

export type ImageInput = { media_type: "image/jpeg" | "image/png" | "image/webp"; data: string };

export type StructuredOpts<T> = {
  system: string;
  user: string | Array<{ text: string } | { image: ImageInput }>;
  schema: z.ZodType<T>;
  name: string;                   // json_schema name, also the log prefix
  effort?: "low" | "medium";
  max_tokens?: number;
  kind?: keyof Usage;             // usage bucket; omitted = not banked
};

export type StructuredResult<T> = { value: T; usage: UsageLine };

// ---- Anthropic --------------------------------------------------------------------
// Opus 5 list price, $/MTok — input 5, output 25, cache write 6.25, cache read 0.50
function anthropicUsage(u: Anthropic.Messages.Usage): UsageLine {
  const cw = u.cache_creation_input_tokens ?? 0, cr = u.cache_read_input_tokens ?? 0;
  return {
    input_tokens: u.input_tokens, output_tokens: u.output_tokens,
    cache_write_tokens: cw, cache_read_tokens: cr,
    usd: (u.input_tokens * 5 + cw * 6.25 + cr * 0.5 + u.output_tokens * 25) / 1e6,
    model: ANTHROPIC_MODEL,
  };
}

let anthropicClient: Anthropic | null = null;
const anthropic = () => (anthropicClient ??= new Anthropic());

async function structuredAnthropic<T>(o: StructuredOpts<T>): Promise<StructuredResult<T>> {
  const content: Anthropic.Messages.ContentBlockParam[] =
    typeof o.user === "string"
      ? [{ type: "text", text: o.user }]
      : o.user.map((p) =>
          "image" in p
            ? { type: "image", source: { type: "base64", media_type: p.image.media_type, data: p.image.data } } as const
            : { type: "text", text: p.text } as const,
        );
  const r = await anthropic().messages.parse({
    model: ANTHROPIC_MODEL,
    max_tokens: o.max_tokens ?? 8000,
    system: [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(o.schema as z.ZodType<object>), effort: o.effort ?? "low" },
  });
  const usage = anthropicUsage(r.usage);
  if (o.kind) recordUsage(o.kind, usage);
  if (r.stop_reason === "refusal") throw new Error(`model declined (refusal${r.stop_details?.category ? `: ${r.stop_details.category}` : ""})`);
  if (!r.parsed_output) throw new Error(`no structured output (stop_reason=${r.stop_reason})`);
  return { value: r.parsed_output as T, usage };
}

// ---- OpenRouter -------------------------------------------------------------------
type ChatMessage = { role: "system" | "user" | "assistant"; content: string | Array<Record<string, unknown>> };

type ChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number; completion_tokens?: number; cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; code?: number };
};

/** Free models are rate-limited and their endpoints come and go: 429 (throttled) and 404
 *  ("no endpoints matching your data policy") are both routine, not exceptional. Retrying
 *  the same model would just hit the same wall, so these fail over to the fallback model. */
const FAILOVER_STATUS = (s: number) => s === 429 || s === 404 || s >= 500;

class OpenRouterError extends Error {
  constructor(message: string, readonly status: number, readonly failover: boolean) { super(message); }
}

function openrouterUsage(u: ChatResponse["usage"], model: string): UsageLine {
  return {
    input_tokens: u?.prompt_tokens ?? 0,
    output_tokens: u?.completion_tokens ?? 0,          // includes the model's reasoning tokens
    cache_write_tokens: 0,
    cache_read_tokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    usd: Number(u?.cost ?? 0),                         // free tier: 0, and we report the real figure
    model,
  };
}

/** A free model returns prose around its JSON often enough to be worth handling: take the
 *  first balanced {...} block rather than failing the whole call on a stray "Here you go:". */
function extractJson(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (t.startsWith("{")) return t;
  const start = t.indexOf("{");
  if (start === -1) return t;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return t.slice(start, i + 1);
  }
  return t.slice(start);
}

async function callOpenRouter(model: string, messages: ChatMessage[], jsonSchema: unknown, name: string, maxTokens: number) {
  const r = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://github.com/compralo/autobuy",
      "X-Title": "AutoBuy",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      messages,
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema: jsonSchema } },
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new OpenRouterError(`OpenRouter ${r.status} on ${model}: ${body.slice(0, 300)}`, r.status, FAILOVER_STATUS(r.status));
  }
  const j = (await r.json()) as ChatResponse;
  // A 200 can still carry an error object (upstream provider failures surface this way).
  if (j.error) {
    const status = j.error.code ?? 502;
    throw new OpenRouterError(`OpenRouter ${status} on ${model}: ${j.error.message ?? "unknown error"}`, status, FAILOVER_STATUS(status));
  }
  const content = j.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new OpenRouterError(`OpenRouter returned empty content on ${model}`, 502, true);
  return { content, usage: j.usage };
}

async function structuredOpenRouter<T>(o: StructuredOpts<T>): Promise<StructuredResult<T>> {
  // Images have no place to go on a text-only free model; drop them and say so once.
  const parts = typeof o.user === "string" ? [{ text: o.user }] : o.user;
  const dropped = parts.filter((p) => "image" in p).length;
  if (dropped) console.warn(`[llm/${o.name}] openrouter: ${dropped} image(s) dropped — this OpenRouter adapter currently uses text input`);
  const userText = parts.filter((p): p is { text: string } => "text" in p).map((p) => p.text).join("\n\n");

  const jsonSchema = z.toJSONSchema(o.schema as z.ZodType<object>, { target: "draft-7" }) as Record<string, unknown>;
  delete jsonSchema.$schema;                            // strict mode wants the bare schema
  const maxTokens = o.max_tokens ?? 8000;

  const models = [OPENROUTER_MODEL, OPENROUTER_MODEL_FALLBACK].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastError: Error | null = null;

  for (const model of models) {
    const messages: ChatMessage[] = [{ role: "system", content: o.system }, { role: "user", content: userText }];
    // Two attempts per model: a free model that returns malformed JSON usually fixes it when
    // shown the validation error, and that is far cheaper than failing the whole tick.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { content, usage } = await callOpenRouter(model, messages, jsonSchema, o.name, maxTokens);
        const line = openrouterUsage(usage, model);
        try {
          const value = o.schema.parse(JSON.parse(extractJson(content)));
          if (o.kind) recordUsage(o.kind, line);
          return { value, usage: line };
        } catch (parseErr) {
          if (o.kind) recordUsage(o.kind, line);        // the tokens were spent either way
          const detail = parseErr instanceof z.ZodError ? JSON.stringify(parseErr.issues.slice(0, 6)) : String(parseErr);
          if (attempt === 2) { lastError = new Error(`${model} returned unusable JSON: ${detail.slice(0, 300)}`); break; }
          console.warn(`[llm/${o.name}] ${model} attempt ${attempt} failed schema validation, retrying with the error`);
          messages.push({ role: "assistant", content });
          messages.push({ role: "user", content: `That response did not satisfy the schema: ${detail.slice(0, 500)}\nReturn ONLY the corrected JSON object, no prose.` });
        }
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (e instanceof OpenRouterError && e.failover) {
          console.warn(`[llm/${o.name}] ${model} unavailable (${e.status}) — trying the next model`);
          break;                                        // next model, not another attempt here
        }
        break;
      }
    }
  }
  throw lastError ?? new Error("OpenRouter call failed");
}

// ---- The one entry point ----------------------------------------------------------
export async function structured<T>(o: StructuredOpts<T>): Promise<StructuredResult<T>> {
  if (PROVIDER === "anthropic") return structuredAnthropic(o);
  if (PROVIDER === "openrouter") return structuredOpenRouter(o);
  throw new Error("no LLM provider configured: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in packages/backend/.env");
}

export const fmtUsage = (u: UsageLine) =>
  PROVIDER === "openrouter"
    ? `in=${u.input_tokens} out=${u.output_tokens} $${u.usd.toFixed(4)} ${u.model ?? ""}`.trim()
    : `in=${u.input_tokens} out=${u.output_tokens} cache_w=${u.cache_write_tokens} cache_r=${u.cache_read_tokens} $${u.usd.toFixed(4)}`;
