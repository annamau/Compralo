# Installing the AutoBuy extension

Chrome MV3, unpacked, no store listing. Two ways in; the first is the one to use on stage.

## Load unpacked (recommended)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select `autobuy/packages/extension` (the folder containing `manifest.json`, not a zip).
4. **Pin it**: click the puzzle-piece icon in the toolbar, then the pin next to **AutoBuy**. The demo depends on the icon being one click away.
5. **Verify**: open any product page (a real retailer, or `https://example.com` for a fixture read), click the AutoBuy icon. The side panel opens and says `Reading <host>…`, then shows the product it read. If it shows an error naming the backend URL, the backend is not running — see below.

After editing any file in this folder, hit the ↻ reload icon on the AutoBuy card in `chrome://extensions`. Editing `manifest.json` always needs that reload; editing `panel.js` usually needs only the panel to be closed and reopened.

## The alternative: the demo browser (no clicks)

```bash
./autobuy/packages/extension/demo-browser.sh
```

This launches **Chrome for Testing** with the extension pre-loaded and its own persistent
profile (`~/.compralo/chrome-profile`), so the pinned icon and the saved backend URL survive
relaunches. Pass a product URL as the argument to open one instead of the dashboard.

Why not your normal Chrome: **branded Google Chrome has ignored `--load-extension` since
137** — it opens a window and says nothing. Chrome for Testing honours it. The script finds
the newest build Playwright left in `~/Library/Caches/ms-playwright`; with none there,
`npx @puppeteer/browsers install chrome@stable` and point `CHROME_FOR_TESTING` at the binary.

## Pointing it at a backend

The panel talks to one backend, default `http://localhost:3000`. To change it: open the panel, expand **Backend** at the bottom, type the base URL (no trailing slash), **Save**. It is stored in `chrome.storage.sync` and survives extension reloads.

Two origins ship in `manifest.json` `host_permissions`:

| URL | What it is |
|---|---|
| `http://localhost:3000` | the laptop running `npm run dev` |
| `https://34-175-42-226.sslip.io` | the deployed box |

MV3 will not let the panel fetch an origin the manifest was not built with, and the failure is a silent CORS error rather than a prompt. To point at anything else — a tunnel, a teammate's laptop — add it to `host_permissions` and reload the extension. The panel's **Backend** hint tells you when the URL you typed is not one of the declared ones.

## What the extension needs running

The backend refuses to boot without the money service, so start them in this order:

```bash
cd money && npm start          # P4 money :4242 — holds, captures, releases, Zinc
cd autobuy && npm run dev      # market :4000 + backend :3000
```

Then reload the panel. `Open dashboard ↗` in the footer points at whichever backend is configured.
