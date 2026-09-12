/**
 * Service worker. Deliberadamente casi vacío.
 *
 * Todo el trabajo pesado vive en el side panel, y por dos razones concretas:
 *
 *  1. Un service worker MV3 **no tiene DOM**: no hay `Image` ni
 *     `document.createElement('canvas')`. Reescalar el screenshot aquí exigiría
 *     `OffscreenCanvas` sin necesidad, cuando el panel es un documento real y
 *     puede llamar a `chrome.tabs.captureVisibleTab` por su cuenta.
 *
 *  2. Con `openPanelOnActionClick: true` **no se dispara `action.onClicked`**.
 *     El clic en el icono abre el panel y nada más; así que el trigger de la
 *     captura tiene que ser el propio montaje del panel, no un evento de aquí.
 *
 * Si este fichero crece, casi siempre significa que algo se ha puesto en el
 * sitio equivocado.
 */

chrome.runtime.onInstalled.addListener(() => {
  // El icono abre el side panel en cualquier página. El scope de P2 a T+0:30 es
  // exactamente esto y nada más.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => console.error('[compralo] setPanelBehavior falló', error));
});

// `onInstalled` no se vuelve a disparar cuando el worker se recicla, así que se
// reafirma al arrancar. Es idempotente.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) => console.error('[compralo] setPanelBehavior falló', error));

export {};
