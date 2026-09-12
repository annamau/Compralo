# mocks/ — respuestas estáticas por endpoint

**Ruta fijada por [`docs/CONTRACTS.md § Mocks`](../docs/CONTRACTS.md).** No la muevas
sin el acuerdo de los cuatro carriles: tres personas apuntan aquí.

## Fuente única

Estos ficheros son la **única** copia de los mocks en el repo. Ningún cliente los
duplica dentro de su propio `src/`: la extensión los importa por alias de build,
los servicios los leen de disco. Dos copias de un mock en el seam más frágil del
proyecto es exactamente cómo se pierde una hora a T+3:00.

## Ficheros esperados

JSON plano, nombrado por endpoint:

| Fichero | Dueño | Contenido | Publica |
|---------|-------|-----------|---------|
| `understand.json` | P3 | `canonical` + `listing` + `constraint_schema` | T+0:20 |
| `discover.json` | P3 | candidatos cross-retailer con `match_confidence` | T+0:20 |
| `adjudicate.json` | P3 | veredicto y hechos resueltos de una oferta | T+0:20 |
| `instructions.json` | P1 | watch list en `ARMED`, `EVALUATING`, `AWAITING_APPROVAL` | T+0:15 |

Todo cliente los consume detrás de un flag de entorno (`MOCK=1`, `VITE_MOCK=true`)
y lo apaga en el freeze.

## Reglas que el contenido debe respetar

- El dinero es **enteros en céntimos**. Nunca un float, en ningún idioma.
- `total_cents` significa **puesto en casa, con envío incluido**.
- P3 devuelve hechos, nunca decisiones. Si aparece la palabra *should* en un
  campo de respuesta, está en el carril equivocado.
