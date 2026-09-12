# extension/ — P2

Extensión Chrome MV3: side panel, login, captura de pantalla, skeleton <200 ms,
renderizador genérico del `constraint_schema` y watch list de órdenes.

- **Alcance:** [`docs/scopes/P2-extension.md`](../docs/scopes/P2-extension.md)
- **Contexto de handoff:** [`docs/plans/CLAUDE_CONTEXT.md`](../docs/plans/CLAUDE_CONTEXT.md)
- **Plan técnico y árbol de ficheros:** [`docs/plans/IMPLEMENTATION_PLAN_P2.md`](../docs/plans/IMPLEMENTATION_PLAN_P2.md)

## Las dos reglas que no se negocian aquí

1. **Nunca branching por `key`.** El formulario dinámico se renderiza
   estrictamente por `type` (`enum`, `bool`, `money`, `date`, `int`). El Beat 2
   de la demo es demostrar que nadie hardcodeó el formulario.
2. **Skeleton pintado en <200 ms** desde metadatos locales del DOM
   (OpenGraph / JSON-LD / título), antes de que responda cualquier red.

## Consumo de mocks

`VITE_MOCK=true` sirve desde [`../mocks/`](../mocks/) y [`../fixtures/`](../fixtures/)
por alias de build. **No copies esos JSON dentro de `src/`** — la raíz es la
fuente única.
