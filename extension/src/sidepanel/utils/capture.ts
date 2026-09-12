/**
 * Fase 3: la captura de pantalla que alimenta `/understand`.
 *
 * Corre **en el side panel**, no en el service worker, por una razón dura: un
 * worker MV3 no tiene DOM — ni `Image` ni `canvas` — y el panel sí, porque es un
 * documento de verdad. Hacerlo aquí ahorra el viaje de ida y vuelta al worker y
 * un `OffscreenCanvas` innecesario.
 *
 * Nunca bloquea el esqueleto: se lanza en paralelo a las fases 1 y 2.
 */

/** Ancho máximo acordado con P3 (A5). Una captura a 2x DPR pesa de más. */
const MAX_WIDTH = 1024;

/** Calidad de la captura inicial, antes del reescalado. */
const CAPTURE_QUALITY = 80;

/** Calidad del JPEG final que viaja por la red. */
const OUTPUT_QUALITY = 0.7;

export type CaptureResult =
  | { ok: true; screenshotB64: string; width: number; height: number; bytes: number }
  | { ok: false; reason: string };

/**
 * Captura la pestaña visible y la reescala. Devuelve **base64 puro**, sin el
 * prefijo `data:image/jpeg;base64,` — formato congelado en A5.
 */
export async function captureActiveTab(): Promise<CaptureResult> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.captureVisibleTab) {
    return { ok: false, reason: 'Sin contexto de extensión: no hay pestaña que capturar.' };
  }

  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab({
      format: 'jpeg',
      quality: CAPTURE_QUALITY,
    });
  } catch (error) {
    // El caso realista: `activeTab` se concede al invocar la extensión en una
    // pestaña concreta. Si el usuario cambió de pestaña con el panel abierto,
    // el permiso no cubre la nueva. `host_permissions: <all_urls>` lo evita,
    // pero una página de Chrome o la Web Store sigue rechazando la captura.
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'No se pudo capturar la pestaña.',
    };
  }

  if (!dataUrl) return { ok: false, reason: 'La captura llegó vacía.' };

  try {
    return await downscaleJpeg(dataUrl);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'No se pudo reescalar la captura.',
    };
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('El navegador no pudo decodificar la captura.'));
    image.src = src;
  });
}

async function downscaleJpeg(dataUrl: string): Promise<CaptureResult> {
  const image = await loadImage(dataUrl);

  // La captura sale al devicePixelRatio del equipo, así que en una pantalla 2x
  // llega al doble del ancho CSS. Reescalar no es opcional.
  const scale = image.naturalWidth > MAX_WIDTH ? MAX_WIDTH / image.naturalWidth : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) return { ok: false, reason: 'No hay contexto 2d disponible.' };

  context.drawImage(image, 0, 0, width, height);
  const resized = canvas.toDataURL('image/jpeg', OUTPUT_QUALITY);

  const comma = resized.indexOf(',');
  if (comma === -1) return { ok: false, reason: 'La captura reescalada no es un data URL.' };
  const screenshotB64 = resized.slice(comma + 1);

  return {
    ok: true,
    screenshotB64,
    width,
    height,
    // Tamaño real del payload: 4 caracteres base64 por cada 3 bytes.
    bytes: Math.floor((screenshotB64.length * 3) / 4),
  };
}
