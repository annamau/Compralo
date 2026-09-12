// Loads packages/backend/.env (if present) before anything else reads process.env.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(BACKEND_DIR, "../..");
export const DATA_DIR = resolve(REPO_ROOT, "data");

const envPath = resolve(BACKEND_DIR, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined && value !== "") process.env[m[1]] = value;
  }
}

export const MARKET_URL = process.env.MARKET_URL ?? "http://localhost:4000";
export const PORT = Number(process.env.PORT ?? 3000);
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 3000);

// ---- P4 money service. AutoBuy holds no Stripe key: every hold, capture, release and
// aggregator order goes through it. The backend refuses to boot if it is unreachable.
export const P4_URL = (process.env.P4_URL ?? "http://localhost:4242").replace(/\/+$/, "");

// ---- Exa. Absent EXA_API_KEY the Exa source reports mode "off" and yields no offers.
// EXA_POLL_INTERVAL_MS is deliberately far slower than POLL_INTERVAL_MS: the simulator is
// free and local, the real web costs $0.001 a page and rate-limits. See README.
export const EXA_POLL_INTERVAL_MS = Number(process.env.EXA_POLL_INTERVAL_MS ?? 60_000);
export const EXA_DISCOVERY_TTL_MS = Number(process.env.EXA_DISCOVERY_TTL_MS ?? 3_600_000);
export const EXA_MAX_SELLERS = Number(process.env.EXA_MAX_SELLERS ?? 5);
export const EXA_PAGE_CHARS = Number(process.env.EXA_PAGE_CHARS ?? 8_000);
export const EXA_DOMAINS = (process.env.EXA_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
