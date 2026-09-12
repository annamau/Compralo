# AutoBuy 0.2.0 — Chrome extension

1. Download `autobuy-chrome-extension-v0.2.0.zip` from the GitHub release.
2. Extract the ZIP to a permanent folder.
3. Open `chrome://extensions` in Chrome and enable **Developer mode**.
4. Choose **Load unpacked** and select the extracted `autobuy-chrome-extension` folder containing `manifest.json`.
5. Pin **AutoBuy**, open a product page, and click its toolbar icon.

No terminal, local server or API key is required. This is an unpacked extension release, not a Chrome Web Store installation.

## Cloud connection

Both product reading and Rust buy orders use **https://34-175-42-226.sslip.io** by default. The dashboard uses the same backend. Version 0.2.0 resets old local demo settings to this cloud connection on first use, including any separate AI URL. Close and reopen an existing side panel after upgrading.

The Backend section permits an intentional developer override after initial setup. Leave **Backend base URL** blank to use the cloud default, and **AI service URL** blank to use the same server.

## Demo payments

This hackathon build uses Stripe test payments and Zinc sandbox. No physical goods ship. Product reading does not imply every retailer is supported for checkout. The dashboard shows authorization, monitoring and purchase events returned by the backend.

The extension sends the active product page HTML and, when available, a screenshot to the configured backend to understand the product. Only open it on pages you want it to read.
