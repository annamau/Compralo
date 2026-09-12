/**
 * Fase 1 y 2 del esqueleto: leer la página del usuario sin esperar a la red.
 *
 * Dos niveles, porque el primero es gratis y el segundo cuesta una inyección:
 *
 *   Fase 1 (~10 ms)  `chrome.tabs.query` da `title`, `url` y `favIconUrl` sin
 *                    tocar la página. Es lo que pinta el primer esqueleto.
 *   Fase 2 (~50 ms)  `chrome.scripting.executeScript` extrae JSON-LD, OpenGraph
 *                    y el precio visible, y mejora la tarjeta con imagen real.
 *
 * La llamada pesada a `/understand` viene después y no bloquea ninguna de las dos.
 */

import type { DomHints } from '@/services/api.types';

/** Lo que la UI necesita para pintar. Superconjunto local de `DomHints`. */
export interface PageHints {
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  imageUrl: string | null;
  /** Texto crudo tal como venía en la página (`"399.99"`, `"1.299,00 €"`). */
  priceText: string | null;
  currency: string | null;
  retailer: string | null;
  /** El nodo `Product` de JSON-LD, sin tocar. Viaja a P3 tal cual. */
  jsonld: unknown;
}

/** Fase 1: lo que se sabe de la pestaña sin inyectar nada. */
export interface TabHints {
  tabId: number;
  url: string;
  title: string | null;
  favIconUrl: string | null;
  retailer: string | null;
}

export const isExtensionContext = (): boolean =>
  typeof chrome !== 'undefined' && !!chrome.tabs?.query;

/**
 * Por qué esta página no se puede analizar, si es el caso.
 *
 * El orden de las reglas importa: **una ruta de producto gana siempre**, diga
 * lo que diga la query string. Hay tiendas que arrastran `?q=` en la ficha.
 */
export type PageGuard =
  | { kind: 'ok' }
  | { kind: 'not-web'; message: string }
  | { kind: 'listing'; message: string };

const PRODUCT_PATH =
  /\/(dp|gp\/product|product|producto|products|productos|p|item|itm|prod)\/[^/?#]+/i;

const LISTING_PATH =
  /\/(search|buscar|busqueda|b[uú]squeda|categoria|categorias|category|categories|listado|collections?|marcas?|brand|s|c)(\/|$)/i;

const LISTING_QUERY = /[?&](q|k|query|search|keyword|term|texto)=/i;

export function guardPage(url: string): PageGuard {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'not-web', message: 'No pude leer la dirección de esta pestaña.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      kind: 'not-web',
      message: 'Abre la ficha de un producto y el panel la leerá. Esta página no es web.',
    };
  }

  if (PRODUCT_PATH.test(parsed.pathname)) return { kind: 'ok' };

  if (LISTING_PATH.test(parsed.pathname) || LISTING_QUERY.test(parsed.search)) {
    return {
      kind: 'listing',
      message:
        'Esto parece una búsqueda o una categoría, no un producto. Abre la ficha de uno y lo leo.',
    };
  }

  return { kind: 'ok' };
}

export function retailerFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Fase 1. Barata y sin permisos de página: es el primer paint. */
export async function readActiveTab(): Promise<TabHints | null> {
  if (!isExtensionContext()) return null;

  // `lastFocusedWindow`, no `currentWindow`: desde el contexto de un side panel
  // la "ventana actual" puede no ser la que el usuario está mirando, y en
  // escenarios multi-ventana se lee la pestaña equivocada.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url) return null;

  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title ?? null,
    favIconUrl: tab.favIconUrl ?? null,
    retailer: retailerFromUrl(tab.url),
  };
}

/**
 * Fase 2. El cuerpo de esta función se **serializa** y se ejecuta en la página,
 * así que no puede cerrar sobre nada de este módulo: ni imports, ni constantes,
 * ni otras funciones del fichero. Todo lo que necesita va dentro. Si alguien
 * refactoriza una constante hacia fuera, deja de funcionar en silencio.
 */
function extractPageHints(): PageHints {
  const meta = (selector: string): string | null =>
    document.querySelector<HTMLMetaElement>(selector)?.content?.trim() || null;

  const property = (name: string): string | null =>
    meta(`meta[property="${name}"]`) ?? meta(`meta[name="${name}"]`);

  // ── JSON-LD: busca el primer nodo Product, siguiendo @graph y arrays ──
  const findProduct = (node: unknown, depth = 0): Record<string, unknown> | null => {
    if (depth > 6 || !node) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findProduct(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof node !== 'object') return null;

    const record = node as Record<string, unknown>;
    const type = record['@type'];
    const isProduct = Array.isArray(type)
      ? type.some((t) => String(t).toLowerCase() === 'product')
      : String(type ?? '').toLowerCase() === 'product';
    if (isProduct) return record;

    for (const key of ['@graph', 'mainEntity', 'itemListElement']) {
      const found = findProduct(record[key], depth + 1);
      if (found) return found;
    }
    return null;
  };

  let jsonld: Record<string, unknown> | null = null;
  for (const script of Array.from(
    document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
  )) {
    try {
      const found = findProduct(JSON.parse(script.textContent ?? ''));
      if (found) {
        jsonld = found;
        break;
      }
    } catch {
      // Un bloque JSON-LD malformado es habitual; se ignora y se sigue.
    }
  }

  // ── Oferta dentro del JSON-LD (puede venir como objeto o lista) ──
  const rawOffers = jsonld?.['offers'];
  const offer = (Array.isArray(rawOffers) ? rawOffers[0] : rawOffers) as
    | Record<string, unknown>
    | undefined;

  const str = (value: unknown): string | null => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
  };

  // ── Imagen: OpenGraph, luego JSON-LD, luego la mayor renderizada ──
  const jsonldImage = (() => {
    const image = jsonld?.['image'];
    if (Array.isArray(image)) return str(image[0]);
    if (image && typeof image === 'object') return str((image as Record<string, unknown>)['url']);
    return str(image);
  })();

  const largestImage = (): string | null => {
    let best: string | null = null;
    let bestArea = 0;
    // Techo en 120 nodos: esto corre en el hilo principal de la página del
    // usuario y no debe costar más que un frame.
    const images = Array.from(document.images).slice(0, 120);
    for (const img of images) {
      const area = img.clientWidth * img.clientHeight;
      if (area > bestArea && area > 40_000 && img.currentSrc) {
        bestArea = area;
        best = img.currentSrc;
      }
    }
    return best;
  };

  // ── Precio: OpenGraph, JSON-LD, y como último recurso el texto visible ──
  const visiblePrice = (): string | null => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[itemprop="price"], [class*="price" i], [data-price], [id*="price" i]',
      ),
    ).slice(0, 40);
    const pattern = /(?:€\s*)?\d{1,3}(?:[.\s]\d{3})*(?:[.,]\d{2})?\s*€?/;
    for (const element of candidates) {
      const text = (element.textContent ?? '').trim();
      if (!text || text.length > 40) continue;
      const match = pattern.exec(text);
      if (match?.[0] && /\d/.test(match[0])) return match[0].trim();
    }
    return null;
  };

  return {
    url: location.href,
    canonicalUrl:
      document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || null,
    title:
      property('og:title') ??
      str(jsonld?.['name']) ??
      document.querySelector('h1')?.textContent?.trim() ??
      document.title ??
      null,
    imageUrl: property('og:image') ?? jsonldImage ?? largestImage(),
    priceText:
      property('og:price:amount') ??
      property('product:price:amount') ??
      str(offer?.['price']) ??
      visiblePrice(),
    currency:
      property('og:price:currency') ??
      property('product:price:currency') ??
      str(offer?.['priceCurrency']),
    retailer: location.hostname.replace(/^www\./, ''),
    jsonld,
  };
}

/** Fase 2. Inyecta y recoge. Devuelve `null` si la página no deja inyectar. */
export async function readPageHints(tabId: number): Promise<PageHints | null> {
  if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) return null;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageHints,
      // Mundo aislado: el JSON-LD y los meta están en el DOM, no hace falta
      // compartir contexto con los scripts de la tienda.
      world: 'ISOLATED',
    });
    return (result?.result as PageHints | undefined) ?? null;
  } catch (error) {
    // Páginas del propio Chrome, la Web Store y PDFs rechazan la inyección.
    // No es un fallo del panel: la Fase 1 ya pintó algo legible.
    console.warn('[compralo] no se pudo inyectar el lector de página', error);
    return null;
  }
}

/**
 * Reduce los hints al subconjunto **congelado** que viaja a P3 (seam T+0:45).
 * Todo lo demás de `PageHints` es para pintar y se queda en el panel.
 */
export function toDomHints(hints: PageHints | null, fallbackTitle: string | null): DomHints {
  return {
    title: hints?.title ?? fallbackTitle,
    price: hints?.priceText ?? null,
    jsonld: hints?.jsonld ?? null,
  };
}
