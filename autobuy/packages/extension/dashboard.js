const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
let base, snapshot = {}, busy = false;
const openLogs = new Set();
const money = (minor, currency) => `${(minor / 100).toFixed(2)} ${currency ?? ''}`;
const sameUrl = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '') && x.search === y.search; } catch { return false; } };
function eventText(e) {
  const p = e.payload ?? {};
  if (e.kind === 'offer_observed' || e.kind === 'initial_offer_observed') return p.offer?.available ? 'Product link checked · In stock' : p.offer?.available === false ? 'Product link checked · Out of stock' : 'Product link checked';
  if (e.kind === 'payment_authorized') return p.provider_reference?.startsWith('pi_') ? 'Stripe authorization recorded' : 'Demo authorization recorded';
  if (e.kind === 'purchase_confirmed') return `Purchase confirmed · ${p.order_id}${p.total_minor != null ? ` · ${money(p.total_minor, p.currency)}` : ''}`;
  if (p.error) return `${e.kind.replaceAll('_', ' ')} · ${p.error}`;
  if (e.kind === 'offer_evaluated') return `Offer evaluated · ${typeof p.decision === 'string' ? p.decision : JSON.stringify(p.decision)}`;
  return e.kind.replaceAll('_', ' ');
}
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
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname);
    $('connection').textContent = `${local ? 'LOCAL RUST' : 'CLOUD RUST'} · ${base} · ${monitors.length} orders · updated ${new Date().toLocaleTimeString()}`;
    $('error').textContent = '';
    $('ai').replaceChildren();
    $('ai').hidden = true;
    if (last_understanding && monitors.some(m => sameUrl(m.url, last_understanding.url))) {
      $('ai').hidden = false;
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
      const failure = events.findLast(e => ['qualified_offer_not_executed', 'execution_failed', 'payment_required', 'monitor_check_failed'].includes(e.kind));
      if (failure && (!purchase || events.indexOf(failure) > events.indexOf(purchase))) {
        const notice = el('div', null, 'notice');
        notice.append(el('strong', failure.kind === 'monitor_check_failed' ? 'Latest stock check failed' : 'Latest checkout issue'), el('p', failure.payload?.error ?? eventText(failure)), el('small', new Date(failure.created_at).toLocaleTimeString()));
        card.append(notice);
      }
      const timeline = el('ol', null, 'timeline');
      const milestones = events.filter(e => ['payment_authorized', 'offer_observed', 'initial_offer_observed', 'execution_started', 'purchase_confirmed', 'monitor_cancelled', 'execution_failed', 'qualified_offer_not_executed', 'monitor_check_failed', 'payment_required'].includes(e.kind));
      const compact = milestones.filter((e, i) => i === milestones.length - 1 || eventText(e) !== eventText(milestones[i + 1]));
      for (const e of compact.slice(-6)) {
        const item = el('li'); item.append(el('time', new Date(e.created_at).toLocaleTimeString(), 'time'), el('span', eventText(e)));
        if (e.kind === 'purchase_confirmed') item.className = 'confirmed';
        timeline.append(item);
      }
      card.append(timeline, el('small', `Rust monitor ${m.id}`));
      if (!['purchased', 'cancelled', 'expired'].includes(m.status)) {
        const cancel = el('button', 'Cancel monitor');
        cancel.addEventListener('click', async () => { cancel.disabled = true; try { await get(`/v1/monitors/${m.id}/cancel`, { method: 'POST' }); await refresh(); } catch (e) { $('error').textContent = e.message; cancel.disabled = false; } });
        const row = el('p'); row.append(cancel); card.append(row);
      }
      const detail = el('details'); detail.open = openLogs.has(m.id); detail.append(el('summary', `Raw event evidence · ${events.length} events`));
      detail.addEventListener('toggle', () => { if (detail.isConnected) detail.open ? openLogs.add(m.id) : openLogs.delete(m.id); });
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
