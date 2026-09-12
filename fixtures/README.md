# fixtures/ — las ofertas de la demo

**Ruta fijada por [`docs/CONTRACTS.md § Demo fixtures`](../docs/CONTRACTS.md).**
Dueño: **P3**, entrega a T+2:45.

`offers.json` contiene las cuatro ofertas que enciende la demo, para que
cualquiera pueda repetir la secuencia sin esperar un restock real:

| # | Sticker | Esperado | Por qué |
|---|---------|----------|---------|
| 1 | €219 | REJECTED | Generación anterior bajo un título casi idéntico |
| 2 | €244 | REJECTED | Add-on obligatorio en checkout — total real €282 |
| 3 | €248 | QUALIFIES | Variante correcta, vendedor aprobado, entregado dentro del límite |
| 4 | €465 | DECLINED | Sobre el techo de €250 — rechazado por Stripe, `amount_too_large` |

> La oferta 4 existe **solo** para que la rechace la capa de pago. Es el último
> beat de la demo: que no la rechace código de aplicación. `money/fixtures.sh`
> dispara las cuatro contra una instancia viva.

Las ofertas 1 y 2 mueren en la compuerta determinista de P1 y nunca llegan a P4.
