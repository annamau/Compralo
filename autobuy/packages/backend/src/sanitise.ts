// Turns a full product page into something worth sending to a model: ld+json Product data first
// (deterministic identifiers beat inference), then the visible HTML with scripts, styles, SVG,
// comments, event handlers and attribute noise removed, capped at ~40k characters.
import * as cheerio from "cheerio";

export type Sanitised = { ldjson: string | null; text: string; original_chars: number; sent_chars: number };

const KEEP_ATTRS = new Set(["alt", "content", "name", "property", "itemprop", "datetime", "value", "selected", "checked", "disabled", "title", "aria-label", "type"]);

export function sanitise(html: string, cap = 40_000): Sanitised {
  const $ = cheerio.load(html);

  // 1. Structured data, read BEFORE scripts are removed.
  const blocks = $('script[type="application/ld+json"]').map((_, e) => $(e).text()).get()
    .filter((t) => /Product/.test(t))
    .map((t) => { try { return JSON.stringify(JSON.parse(t)); } catch { return t.replace(/\s+/g, " "); } });
  const ldjson = blocks.length ? blocks.join("\n").slice(0, 8000) : null;

  // 2. Strip what a buyer never sees.
  $("script, style, svg, noscript, iframe, link, template, canvas, video, audio, object, embed").remove();
  $("*").contents().each((_, n) => { if (n.type === "comment") $(n).remove(); });
  $("*").each((_, e) => {
    if (!("attribs" in e)) return;
    for (const a of Object.keys(e.attribs)) if (/^on/i.test(a) || !KEEP_ATTRS.has(a)) $(e).removeAttr(a);
  });

  // 3. Head signals, then the body, whitespace collapsed.
  const head = ($("title").first().toString() + $('meta[name="description"], meta[property^="og:"], meta[property^="product:"], meta[itemprop]').toString());
  const body = ($("body").html() ?? $.root().html() ?? "").replace(/\s+/g, " ").replace(/> </g, "><");
  const text = (head + "\n" + body).slice(0, cap);
  return { ldjson, text, original_chars: html.length, sent_chars: text.length + (ldjson?.length ?? 0) };
}
