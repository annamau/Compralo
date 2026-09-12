// Where the backend lives. One extension, three places it can point:
//   localhost           the laptop demo
//   the deployed box    a phone on the venue wifi, or a laptop that is not the one running it
//   anything else       a teammate's tunnel
//
// The default is the laptop. A value saved in chrome.storage.sync overrides it and survives a
// reload of the unpacked extension, so the operator sets it once. Whatever it is, it must also
// be in manifest.json's host_permissions — MV3 will not let the panel fetch an origin it was
// not declared with, and the failure is a silent CORS error, not a prompt.
const DEFAULT_BACKEND_URL = "https://34-175-42-226.sslip.io";
async function intelligenceUrl() {
  const { intelligence_url } = await chrome.storage.sync.get("intelligence_url");
  return trim(intelligence_url) || await backendUrl();
}

// The origins this build is allowed to talk to, from the manifest. Shown in the panel so an
// operator who types something unreachable gets told why rather than a blank panel.
const KNOWN_BACKENDS = [
  "http://localhost:3000",
  "https://34-175-42-226.sslip.io",
];

const trim = (u) => String(u ?? "").trim().replace(/\/+$/, "");

/** The backend base URL for this session. Storage first, default second. */
async function backendUrl() {
  try {
    const { backend_url } = await chrome.storage.sync.get("backend_url");
    return trim(backend_url) || DEFAULT_BACKEND_URL;
  } catch {
    return DEFAULT_BACKEND_URL; // storage unavailable (rare); the demo still runs on the default
  }
}

/** Persist a new backend. Empty string resets to the default. */
async function setBackendUrl(url) {
  const v = trim(url);
  await chrome.storage.sync.set({ backend_url: v });
  return v || DEFAULT_BACKEND_URL;
}
