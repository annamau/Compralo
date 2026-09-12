/**
 * Orquesta las cuatro fases del análisis de producto.
 *
 *   1. `chrome.tabs.query`      → primer paint, ~10 ms, sin tocar la página
 *   2. `executeScript` JSON-LD  → imagen y precio locales, ~50 ms
 *   3. `captureVisibleTab`      → **en paralelo**, no bloquea nada de lo anterior
 *   4. `POST /understand`       → producto canónico + `constraint_schema`
 *
 * El orden importa: 1 y 2 pintan antes de que salga una sola petición de red, y
 * 3 no se interpone entre ellas. La regla es que nunca haya un spinner sobre un
 * panel vacío, porque es donde esta demo muere emocionalmente.
 *
 * El panel vive abierto mientras el usuario navega, así que la mitad del trabajo
 * de este hook es **disciplina de relectura**: no pintar el producto de una
 * pestaña que ya no se está mirando, no reanalizar lo mismo dos veces, y no
 * parpadear a blanco al refrescar.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { understand } from '@/services/apiClient';
import type { UnderstandResponse } from '@/services/api.types';
import { captureActiveTab, type CaptureResult } from '../utils/capture';
import {
  guardPage,
  isExtensionContext,
  readActiveTab,
  readPageHints,
  retailerFromUrl,
  toDomHints,
  type PageGuard,
  type PageHints,
  type TabHints,
} from '../utils/domReader';

export type AnalysisPhase =
  | 'idle'
  | 'tab'
  | 'hints'
  | 'understanding'
  | 'ready'
  | 'error'
  /** La página no es analizable: no es web, o es un listado en vez de una ficha. */
  | 'unsupported';

export interface AnalysisTimings {
  /** ms hasta el primer contenido en pantalla. Este es el número de la promesa. */
  firstPaint?: number;
  hints?: number;
  capture?: number;
  understand?: number;
}

export interface AnalysisState {
  phase: AnalysisPhase;
  tab: TabHints | null;
  hints: PageHints | null;
  capture: CaptureResult | null;
  understanding: UnderstandResponse | null;
  error: string | null;
  guard: PageGuard | null;
  timings: AnalysisTimings;
  /** `true` cuando el panel corre fuera de una extensión (dev en pestaña). */
  simulated: boolean;
  /** Relectura en curso sobre contenido que ya está en pantalla. */
  refreshing: boolean;
}

const INITIAL: AnalysisState = {
  phase: 'idle',
  tab: null,
  hints: null,
  capture: null,
  understanding: null,
  error: null,
  guard: null,
  timings: {},
  simulated: false,
  refreshing: false,
};

/** Ventana en la que una relectura de la misma URL se considera redundante. */
const DEDUPE_MS = 4000;

/** Muchas tiendas hidratan el precio después del `load`. Un reintento, uno solo. */
const LATE_PRICE_RETRY_MS = 2500;

/** Debounce de los disparadores de pestaña, para no reanalizar en cada evento. */
const TRIGGER_DEBOUNCE_MS = 400;

/** Respaldo para SPAs cuyas navegaciones no emiten eventos de pestaña. */
const URL_POLL_MS = 1500;

/**
 * Sustituto para desarrollar el panel en una pestaña normal con `vite dev`,
 * donde no existe `chrome.tabs`. Se marca como simulado en el estado y la UI lo
 * dice: un panel que finge haber capturado una página no es aceptable.
 */
const DEV_TAB: TabHints = {
  tabId: -1,
  url: 'https://www.pccomponentes.com/sony-playstation-5-slim-digital-1tb',
  title: 'PlayStation 5 Slim Digital 1TB — PcComponentes',
  favIconUrl: null,
  retailer: 'pccomponentes.com',
};

export function useProductAnalysis(): AnalysisState & { restart: () => void } {
  const [state, setState] = useState<AnalysisState>(INITIAL);

  const runId = useRef(0);
  const lastReadUrl = useRef<string | null>(null);
  const lastReadAt = useRef(0);
  const retriedUrls = useRef(new Set<string>());
  const retryTimer = useRef<number | undefined>(undefined);

  const run = useCallback(async (force: boolean) => {
    const id = ++runId.current;
    const alive = () => runId.current === id;
    const started = performance.now();
    const since = () => Math.round(performance.now() - started);

    // Nada se borra al empezar. AutoBuy oculta el producto en cada relectura y
    // el panel parpadea a blanco al cambiar de pestaña; con una animación de
    // upgrade como la nuestra, eso arruina justo el momento que se demuestra.
    setState((prev) => ({ ...prev, refreshing: true }));

    const simulated = !isExtensionContext();
    const tab = simulated ? DEV_TAB : await readActiveTab();
    if (!alive()) return;

    if (!tab) {
      setState({ ...INITIAL, phase: 'error', error: 'No se pudo leer la pestaña activa.' });
      return;
    }

    // Dedupe: cambiar de pestaña y volver dispara dos eventos por la misma URL.
    if (!force && tab.url === lastReadUrl.current && Date.now() - lastReadAt.current < DEDUPE_MS) {
      setState((prev) => ({ ...prev, refreshing: false }));
      return;
    }

    // Un listado se puede leer igualmente si el usuario insiste — a veces una
    // ficha vive en una ruta con pinta de categoría. Una página que no es web no
    // tiene nada que leer, y ahí no hay override que valga.
    const guard = simulated ? ({ kind: 'ok' } as PageGuard) : guardPage(tab.url);
    const overridable = force && guard.kind === 'listing';
    if (guard.kind !== 'ok' && !overridable) {
      lastReadUrl.current = tab.url;
      lastReadAt.current = Date.now();
      setState({ ...INITIAL, phase: 'unsupported', tab, guard, simulated });
      return;
    }

    const urlChanged = tab.url !== lastReadUrl.current;
    lastReadUrl.current = tab.url;
    lastReadAt.current = Date.now();

    // ── Fase 1 ────────────────────────────────────────────────────────────
    // Si la URL cambió, lo anterior es de otro producto y se descarta. Si es la
    // misma, se conserva y solo se refresca encima.
    setState((prev) => ({
      ...prev,
      phase: 'hints',
      tab,
      guard,
      simulated,
      error: null,
      hints: urlChanged ? null : prev.hints,
      capture: urlChanged ? null : prev.capture,
      understanding: urlChanged ? null : prev.understanding,
      timings: urlChanged ? { firstPaint: since() } : { ...prev.timings, firstPaint: since() },
    }));

    // ── Fases 2 y 3 en paralelo ───────────────────────────────────────────
    // La captura no se interpone: si tarda, el esqueleto ya está mejorado con
    // los hints del DOM y el usuario tiene algo real delante.
    const hintsPromise = simulated
      ? Promise.resolve<PageHints | null>(null)
      : readPageHints(tab.tabId);
    const capturePromise = captureActiveTab();

    const hints = await hintsPromise;
    if (!alive()) return;
    if (hints) {
      setState((prev) => ({ ...prev, hints, timings: { ...prev.timings, hints: since() } }));

      // Reintento único si el precio aún no estaba pintado. El Set se acota
      // para que no crezca durante toda la vida del panel.
      if (hints.priceText == null && !retriedUrls.current.has(tab.url)) {
        if (retriedUrls.current.size > 20) retriedUrls.current.clear();
        retriedUrls.current.add(tab.url);
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => void run(true), LATE_PRICE_RETRY_MS);
      }
    }

    const capture = await capturePromise;
    if (!alive()) return;
    setState((prev) => ({ ...prev, capture, timings: { ...prev.timings, capture: since() } }));

    // ── Fase 4 ────────────────────────────────────────────────────────────
    setState((prev) => ({ ...prev, phase: 'understanding' }));

    try {
      const understanding = await understand({
        url: hints?.canonicalUrl ?? hints?.url ?? tab.url,
        screenshot_b64: capture.ok ? capture.screenshotB64 : '',
        dom_hints: toDomHints(hints, tab.title),
      });
      if (!alive()) return;
      setState((prev) => ({
        ...prev,
        phase: 'ready',
        understanding,
        refreshing: false,
        timings: { ...prev.timings, understand: since() },
      }));
    } catch (error) {
      if (!alive()) return;
      setState((prev) => ({
        ...prev,
        phase: 'error',
        refreshing: false,
        error: error instanceof Error ? error.message : 'El análisis del producto falló.',
      }));
    }
  }, []);

  // Arranque. El guard existe por el doble montaje de StrictMode en desarrollo:
  // sin él el análisis arranca dos veces y se ven dos animaciones de upgrade.
  useEffect(() => {
    if (runId.current === 0) void run(false);
  }, [run]);

  // Disparadores de relectura: cambio de pestaña, navegación completa, cambio de
  // URL en una SPA, y un poll de respaldo para sitios cuyas navegaciones no
  // emiten ningún evento de pestaña.
  useEffect(() => {
    if (!isExtensionContext()) return;

    let debounce: number | undefined;
    const schedule = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void run(false), TRIGGER_DEBOUNCE_MS);
    };

    const onActivated = () => schedule();

    // `chrome.tabs.onUpdated` no acepta filtro (el parámetro `filter` es de
    // Firefox, no de Chrome), así que se descarta dentro del handler: sin esto
    // llegan eventos de todas las pestañas abiertas, no solo de la activa.
    //
    // El tipo se deriva del propio evento en vez de nombrarlo: el nombre de la
    // interfaz de `changeInfo` ha cambiado entre versiones de `@types/chrome`.
    type OnUpdatedListener = Parameters<typeof chrome.tabs.onUpdated.addListener>[0];
    const onUpdated: OnUpdatedListener = (_tabId, info, tab) => {
      if (tab.active && (info.status === 'complete' || info.url)) schedule();
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);

    // Colgado de la visibilidad: con el panel oculto, consultar la pestaña
    // activa cada 1,5 s durante horas no aporta nada.
    const poll = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void readActiveTab().then((tab) => {
        if (tab && tab.url !== lastReadUrl.current) schedule();
      });
    }, URL_POLL_MS);

    return () => {
      clearTimeout(debounce);
      clearInterval(poll);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [run]);

  useEffect(() => () => clearTimeout(retryTimer.current), []);

  return { ...state, restart: () => void run(true) };
}

/** Tienda a mostrar en la tarjeta, con el mejor dato disponible en cada fase. */
export function retailerLabel(state: AnalysisState): string | null {
  return (
    state.understanding?.listing.retailer ??
    state.hints?.retailer ??
    state.tab?.retailer ??
    (state.tab ? retailerFromUrl(state.tab.url) : null)
  );
}
