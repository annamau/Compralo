# Netlify restock demo

Public product: https://compralo-hackathon-restock.netlify.app/products/ps5-slim/

Site ID: `f5fe993c-c377-4219-a358-fc05964ebe91`. Static public fixture only; no credentials or payment code. Hosting is independent of the laptop. The stock changes through a Netlify deployment, not browser JavaScript or a public admin API. Both rendered text and JSON-LD change together.

Run from this directory with the authenticated Netlify CLI:

```sh
# Reset to out of stock before authorizing a new monitor
node build.mjs
netlify deploy --site f5fe993c-c377-4219-a358-fc05964ebe91 --dir public --prod --no-build

# After Rust has observed/rejected out of stock, simulate restocking
node build.mjs --in-stock
netlify deploy --site f5fe993c-c377-4219-a358-fc05964ebe91 --dir public --prod --no-build
```

The root and `/products/ps5-slim/` show the same product. Use the stable public URL above for the monitor, not a deploy-specific URL. Responses request no caching so a subsequent Rust fetch sees the new state.

Before the sandbox purchase, add `compralo-hackathon-restock.netlify.app` to the cloud money service's `SANDBOX_RETAILERS` (preserve other entries). Recreate money before creating the hold; its state is in memory. Rust constraints must approve that same hostname, edition `digital`, storage `1tb`, new condition, EUR, and a ceiling of €250. No live goods are purchased.

For the presentation: first show AutoBuy reading an actual retailer's page, then use this clearly labeled test store for the controlled out-of-stock -> restock -> sandbox purchase sequence. Real retailer stock cannot be controlled by this demo.
