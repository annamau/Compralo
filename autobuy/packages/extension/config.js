const DEFAULT_BACKEND_URL = "https://34-175-42-226.sslip.io";
// Reset previous demo connections once when this cloud release is first opened.
const CLOUD_CONFIG_VERSION = '0.2.0';
let cloudConfiguration;
function ensureCloudConfiguration() {
  return cloudConfiguration ??= (async () => {
    const current = await chrome.storage.sync.get('cloud_config_version');
    if (current.cloud_config_version !== CLOUD_CONFIG_VERSION) {
      await chrome.storage.sync.set({ backend_url: DEFAULT_BACKEND_URL, intelligence_url: '', cloud_config_version: CLOUD_CONFIG_VERSION });
    }
  })();
}
async function intelligenceUrl() {
  await ensureCloudConfiguration();
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
    await ensureCloudConfiguration();
    const { backend_url } = await chrome.storage.sync.get("backend_url");
    return trim(backend_url) || DEFAULT_BACKEND_URL;
  } catch {
    return DEFAULT_BACKEND_URL; // storage unavailable (rare); the demo still runs on the default
  }
}

/** Persist a new backend. Empty string resets to the default. */
async function setBackendUrl(url) {
  await ensureCloudConfiguration();
  const v = trim(url);
  await chrome.storage.sync.set({ backend_url: v });
  return v || DEFAULT_BACKEND_URL;
}
