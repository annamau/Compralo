import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { createInstruction, listInstructions } from '@/services/apiClient';
import { setMonitoredUrl } from '@/services/monitorsAdapter';
import type { InstructionSummary } from '@/services/api.types';
import { formatCents, parseInputToCents } from '../utils/currency';

const deadlineDefault = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16);

/** UI intentionally limited to the monitor resources served by the Rust API. */
export function BackendMonitorView() {
  const [items, setItems] = useState<InstructionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { try { setError(null); setItems((await listInstructions()).instructions); } catch (e) { setError(e instanceof Error ? e.message : 'No se pudieron cargar los monitores.'); } };
  useEffect(() => { void load(); }, []);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const max = parseInputToCents(String(form.get('maximum')));
    if (!max || max <= 0) return setError('Introduce un máximo válido.');
    setBusy(true); setError(null);
    try {
      const url = String(form.get('url')); setMonitoredUrl(url);
      await createInstruction({ canonical: { name: String(form.get('name')), brand: String(form.get('brand')) || undefined }, constraints: { condition: String(form.get('condition')), bundles_allowed: form.get('bundles') === 'on', ...Object.fromEntries(String(form.get('variants')).split(',').map(x => x.trim()).filter(Boolean).map(x => x.split('=').map(y => y.trim())).filter(x => x.length === 2)) }, max_total_cents: max, currency: String(form.get('currency')).toUpperCase(), deadline: new Date(String(form.get('deadline'))).toISOString(), quantity: 1, retailers: String(form.get('retailers')).split(',').map(x => x.trim()).filter(Boolean) });
      event.currentTarget.reset(); await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo crear el monitor.'); } finally { setBusy(false); }
  };
  return <div className="space-y-3"><section className="card space-y-3"><div><h2 className="text-sm font-semibold text-slate-100">Nuevo monitor</h2><p className="mt-1 text-[11px] text-slate-400">Una URL pública, límites explícitos y una sola unidad.</p></div><form className="space-y-2.5" onSubmit={submit}><input className="input" name="url" type="url" placeholder="https://tienda.example/producto" required /><input className="input" name="name" placeholder="Producto" required /><input className="input" name="brand" placeholder="Marca (opcional)" /><div className="grid grid-cols-2 gap-2"><input className="input" name="maximum" inputMode="decimal" placeholder="Máximo total" required /><input className="input" name="currency" defaultValue="EUR" maxLength={3} required /></div><select className="input" name="condition" defaultValue="new"><option value="new">Nuevo</option><option value="refurbished">Reacondicionado</option><option value="used">Usado</option><option value="unknown">Sin condición</option></select><input className="input" name="retailers" placeholder="Tiendas aprobadas: shop.example, …" /><input className="input" name="variants" placeholder="Variantes: color=black, edition=digital" /><label className="flex gap-2 text-xs text-slate-300"><input name="bundles" type="checkbox" /> Permitir bundles</label><input className="input" name="deadline" type="datetime-local" defaultValue={deadlineDefault()} required /><button className="btn-primary w-full" disabled={busy}>{busy ? 'Creando…' : 'Crear monitor'}</button></form></section>{error && <div className="card flex gap-2 text-xs text-red-200"><AlertTriangle className="size-4 shrink-0" />{error}</div>}<section className="space-y-2"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-100">Monitores del servidor</h2><button className="btn-ghost p-1" onClick={() => void load()}><RefreshCw className="size-3.5" /></button></div>{items.map(item => <article key={item.id} className="card"><div className="flex justify-between gap-2"><strong className="text-xs text-slate-100">{item.canonical.name}</strong><span className="text-[10px] text-mint-400">{item.status}</span></div><p className="mt-1 text-[11px] text-slate-400">Máximo {formatCents(item.max_total_cents)} · hasta {new Date(item.deadline).toLocaleString()}</p></article>)}{items.length === 0 && <p className="text-xs text-slate-400">No hay monitores en este servidor.</p>}</section></div>;
}
