const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
let base, snapshot = {}, busy = false;
async function get(path, options) {
  const r = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Rust ${r.status} on ${path}`);
  return r.status === 204 ? null : r.json();
}
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    base = new URLSearchParams(location.search).get("api") || await backendUrl();
    const monitors = await get('/v1/monitors');
    const entries = await Promise.all(monitors.map(async m => ({ monitor: m, events: await get(`/v1/monitors/${m.id}/events`) })));
    const { last_understanding } = typeof chrome !== 'undefined' && chrome.storage?.local ? await chrome.storage.local.get('last_understanding') : {};
    snapshot = { captured_at: new Date().toISOString(), rust_api: base, understanding: last_understanding, entries };
    $('connection').textContent = `${base} · ${monitors.length} orders · refreshed ${new Date().toLocaleTimeString()}`;
    $('error').textContent = '';
    if (last_understanding) {
      const u = last_understanding;
      $('ai').replaceChildren(el('h2', 'Product understanding'), el('p', `${u.product.name} · ${u.mode} · model ${u.usage?.model ?? 'not reported'}`), el('small', `${u.usage?.input_tokens ?? 0} input / ${u.usage?.output_tokens ?? 0} output tokens · $${Number(u.usage?.usd ?? 0).toFixed(5)}`));
    }
    const root = document.createDocumentFragment();
    for (const { monitor: m, events } of entries.sort((a,b) => b.monitor.created_at.localeCompare(a.monitor.created_at))) {
      const card = el('article');
      card.append(el('span', m.status.replaceAll('_', ' ').toUpperCase(), `badge ${m.status}`), el('h2', m.product?.name ?? 'Reading product…'));
      const link = el('a', m.url); link.href = m.url; link.target = '_blank'; link.rel = 'noopener'; card.append(link);
      card.append(el('p', `Ceiling ${(m.constraints.maximum_total_minor / 100).toFixed(2)} ${m.constraints.currency} · checks every ${m.check_interval_seconds}s · until ${m.deadline.slice(0, 10)}`));
      const payment = events.findLast(e => e.kind === 'payment_authorized');
      const ref = payment?.payload?.provider_reference;
      card.append(el('p', ref?.startsWith('pi_') ? `Stripe authorization recorded: ${ref}` : payment ? 'Demo authorization recorded — Stripe hold not confirmed by this server.' : 'No payment authorization recorded.'));
      const purchase = events.findLast(e => e.kind === 'purchase_confirmed');
      if (purchase) card.append(el('p', `Order confirmation: ${purchase.payload.order_id}`));
      card.append(el('small', `Rust monitor ${m.id}`));
      if (!['purchased', 'cancelled', 'expired'].includes(m.status)) {
        const cancel = el('button', 'Cancel monitor');
        cancel.addEventListener('click', async () => { cancel.disabled = true; try { await get(`/v1/monitors/${m.id}/cancel`, { method: 'POST' }); await refresh(); } catch (e) { $('error').textContent = e.message; cancel.disabled = false; } });
        const row = el('p'); row.append(cancel); card.append(row);
      }
      const detail = el('details'); detail.open = true; detail.append(el('summary', `Rust event log · ${events.length} events`));
      for (const e of events.slice(-40)) { const line = el('div', null, 'event'); line.append(el('span', `${e.created_at} · event ${e.id}`, 'time'), el('div', e.kind.replaceAll('_', ' ')), el('pre', JSON.stringify(e.payload, null, 2))); detail.append(line); }
      card.append(detail); root.append(card);
    }
    // Avoid replacing a card while the user is selecting text or interacting with it.
    if (!document.getSelection()?.toString()) $('monitors').replaceChildren(root);
  } catch (e) { $('error').textContent = `Rust refresh failed: ${e.message}`; }
  finally { busy = false; }
}
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
  const a = el('a'); a.href = url; a.download = `compralo-test-${Date.now()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
void refresh(); setInterval(refresh, 5000);
