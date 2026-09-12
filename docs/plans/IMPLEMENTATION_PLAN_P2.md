# Plan de Implementación P2 (v5 Refinado): Extensión Chrome MV3 de Cómpralo

Este plan incorpora todos los hallazgos críticos de la revisión de **Claude Code**, garantizando un encuadre técnico perfecto con [CONTRACTS.md](../CONTRACTS.md), [BOARD.md](../BOARD.md) y [PAYMENTS.md](../PAYMENTS.md).

---

## Decisiones Críticas y Ajustes de Arquitectura (Post-Revisión Claude)

### 1. Secuencia Instantánea de 3 Fases para el Skeleton (< 200 ms)
Para no bloquear el renderizado inicial esperando la captura de pantalla o la inyección de scripts:
1. **Fase 1 (~10 ms):** Al montar el Side Panel, `chrome.tabs.query({ active: true, currentWindow: true })` obtiene de inmediato `title` y `favIconUrl`. Se pinta el primer esqueleto con shimmer.
2. **Fase 2 (~50 ms):** Inyección on-demand con `chrome.scripting.executeScript` para extraer JSON-LD (`@type: Product`), OpenGraph (`og:image`, `og:price`) y actualizar el esqueleto con imagen y precio local.
3. **Fase 3 (En paralelo, no bloquea UI):** Captura directa con `chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 80 })` en el propio Side Panel, downscale con canvas a ancho ≤ 1024 px (calidad 0.7) y llamada a `POST /understand`.
4. **Fase 4 (Upgrade Beat 2):** Al recibir la respuesta de `/understand`, transición visual CSS fluida que sustituye el esqueleto por el producto canónico y los controles proyectados.

### 2. Contratos de Datos: Tipos Separados y Claridad en Mandato
* **Dos tipos de instrucciones diferenciados:**
  * `InstructionSummary`: Lo que devuelve `GET /instructions` (`id`, `canonical`, `status`, `max_total_cents`, `deadline`, `last_checked_at`).
  * `InstructionDetail`: Lo que devuelve `GET /instructions/:id` (`status`, `mandate`, `funds`, `offers`, `purchase?`, `pending_alternative?`, `last_checkout_attempt?`).
* **El cliente nunca envía `user_id`:** Se resuelve en servidor vía `Authorization: Bearer <token>`.
* **Construcción de `constraints`:** Recolectar `{ [field.key]: value }` iterando el esquema. Recolectar por clave es legítimo; lo prohibido es ramificar la lógica según el nombre de la clave.
* **Separación de Presupuesto:** El campo de techo `max_total_cents` pertenece al formulario de mandato de P2. Si P3 emite un campo `type: 'money'` en `constraint_schema`, se trata como un filtro ordinario que va dentro de `constraints`.
* **Clamp de 7 días:** Pertenece exclusivamente al input `deadline` del mandato (en `MandateSummary`), nunca al componente genérico `type: 'date'`.

### 3. Solución a Trampas Técnicas de Manifest V3
* **Captura y Reescalado en Side Panel:** Dado que el Service Worker no dispone de DOM ni `Image`, la captura y reescalado se ejecutan directamente en el contexto del Side Panel.
* **Permisos del Manifest:** Declarar `host_permissions: ["<all_urls>"]` y `permissions: ["activeTab", "sidePanel", "storage", "scripting"]` para asegurar que `captureVisibleTab` y `executeScript` no fallen al cambiar de pestaña o navegar.
* **Stripe.js fuera del Side Panel:** Debido a la prohibición estricta de scripts remotos por CSP en MV3, P2 no carga `js.stripe.com`. El commit de fondos lo gestiona P1 server-side al llamar a `POST /instructions` devolviendo el bloque `funds`.
* **Stack CSS:** Fijar `tailwindcss@^3.4` (evitando los breaking changes de v4) sin `tailwind-merge`. Layout vertical optimizado para el ancho del panel (~330 px).

---

## Cronograma Reajustado (Protección del Checkpoint T+3:30)

| Hito | Hora Límite | Entregable P2 |
| :--- | :--- | :--- |
| **Scaffold & Tipos** | **T+0:30** | Manifest V3, Side Panel montable, `api.types.ts` con `InstructionSummary`/`Detail`. |
| **Auth & Mocks Base** | **T+0:45** | Login con guardado de token, interceptor 401, placeholders en `mocks/` raíz. |
| **Skeleton 3 Fases** | **T+1:00** | Secuencia `tabs.query` (10ms) → `executeScript` JSON-LD (50ms) → Shimmer en pantalla. |
| **Generic Renderer + Upgrade** | **T+1:45** | Proyección por tipos (`enum`, `bool`, `money`, `date`, `int`) + animación CSS de upgrade. |
| **Cross-Retailer & Mandato** | **T+2:30** | Toggles de tiendas descubiertas + Formulario de mandato con techo en centavos (≤ 7 días). |
| **Watch List & Approval Card** | **T+3:00** | Lista de órdenes (`GET /instructions`), Polling 5s, componente `AWAITING_APPROVAL` y Cancelar. |
| **Baja Confianza & Polish** | **T+3:15** | Manejo de `confidence < 0.7` (confirmación manual) y log de auditoría con las 4 ofertas. |
| **Ventana de Integración** | **T+3:30 → T+4:00** | **CERO código nuevo.** Pruebas end-to-end con P1, P3 y P4. |

---

## Estructura de Archivos del Proyecto

```
extension/
├── manifest.json                  # MV3: sidePanel, activeTab, storage, scripting, host_permissions: <all_urls>
├── package.json                   # React 18, Vite, tailwindcss@^3.4, lucide-react, @crxjs/vite-plugin
├── vite.config.ts                 # Integración CRX y resolución de mocks desde la raíz
├── tailwind.config.js
├── postcss.config.js
├── index.html                     # Entry HTML del Side Panel
└── src/
    ├── background/
    │   └── service-worker.ts      # Configuración de setPanelBehavior
    ├── services/
    │   ├── api.types.ts           # Interfaces estrictas (InstructionSummary, InstructionDetail, etc.)
    │   ├── apiClient.ts           # Cliente HTTP con Bearer token, manejo 401 y switch VITE_MOCK
    │   └── mockStore.ts           # Estado local simulado basado en mocks/ de la raíz
    ├── sidepanel/
    │   ├── main.tsx
    │   ├── App.tsx                # Orquestador con navegación por pestañas y modal de settings
    │   ├── state/
    │   │   ├── authContext.tsx    # Manejo de token y re-prompt ante 401
    │   │   └── orderStore.ts      # Estado reactivo sincronizado con storage
    │   ├── components/
    │   │   ├── AuthView.tsx       # Pantalla de Login rápido
    │   │   ├── Navigation.tsx     # Tabs: [Nueva Orden] [Mis Órdenes (n)]
    │   │   ├── ProductSkeleton.tsx# Esqueleto instantáneo (Fases 1 y 2)
    │   │   ├── ProductCard.tsx    # Tarjeta enriquecida post-understand con animación
    │   │   ├── GenericRenderer.tsx# Proyección estricta por tipo (enum, bool, money, date, int)
    │   │   ├── RetailerToggles.tsx# Checkboxes individuales por tienda
    │   │   ├── MandateForm.tsx    # Techo max_total_cents, deadline <= 7 días y cantidad
    │   │   ├── WatchListView.tsx  # Lista de órdenes activas con polling
    │   │   ├── ApprovalCard.tsx   # Tarjeta de acción para AWAITING_APPROVAL
    │   │   └── DecisionAudit.tsx  # Visualización de ofertas rechazadas y motivo Stripe
    │   └── utils/
    │       ├── capture.ts         # captureVisibleTab + resize en canvas
    │       ├── domReader.ts       # Script inyectado para JSON-LD y OpenGraph
    │       └── currency.ts        # Formateador de centavos a euros
```

---

## Criterios de Aceptación (Definición de Done)

1. Al abrir el Side Panel en cualquier tienda online no testeada, se muestra información preliminar en **< 200 ms**.
2. Al terminar el análisis, aparecen controles adaptados a la categoría **sin haber hardcodeado ninguna clave**.
3. La orden se arma autorizando un techo en centavos a un plazo de **≤ 7 días**.
4. Al ocurrir una oferta alternativa, la **Approval Card** muestra qué cambia, el delta de precio y permite aceptar o rechazar.
5. El registro de auditoría muestra claramente las 4 ofertas de prueba, incluyendo el rechazo de Stripe por `amount_too_large`.
