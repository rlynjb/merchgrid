/**
 * Long-running background worker process for the catalog-audit scan queue.
 *
 * Runs OUTSIDE the Remix request/response cycle (started separately, e.g.
 * `npm run worker`), so it has no inbound HTTP request to authenticate
 * against. To get an Admin GraphQL client for a shop it uses
 * `unauthenticated.admin(shopDomain)` from `./app/shopify.server`, which
 * looks up that shop's stored OFFLINE access token (persisted during OAuth
 * via `PrismaSessionStorage`) and hands back an authenticated client — no
 * user session or request needed.
 *
 * Deliberately NOT unit tested: it needs real Shopify OAuth env vars
 * (`SHOPIFY_API_KEY`, `SHOPIFY_APP_URL`, etc.) just to import
 * `./app/shopify.server`, which is exactly why the actual queue-draining
 * logic lives in `./app/services/scan/worker-core.server` (env-free,
 * fully unit tested) and this file is kept to a thin process loop around
 * it.
 */
import { unauthenticated } from "./app/shopify.server";
import {
  claimAndRunNext,
  type AdminFactory,
} from "./app/services/scan/worker-core.server";

const POLL_MS = 5000;

const adminFactory: AdminFactory = async (shopDomain) => {
  const { admin } = await unauthenticated.admin(shopDomain);
  return admin;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let shuttingDown = false;

function requestShutdown(signal: string): void {
  console.error(`[worker] received ${signal}, shutting down after current iteration`);
  shuttingDown = true;
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

async function main(): Promise<void> {
  console.error("[worker] scan worker starting");

  while (!shuttingDown) {
    let scanId: string | null = null;
    try {
      scanId = await claimAndRunNext(adminFactory);
    } catch (err) {
      // A bad scan (or a transient claim failure) must never kill the
      // whole worker process — log and keep polling so other queued scans
      // for other shops still get processed.
      console.error("[worker] error while claiming/running a scan", err);
    }

    if (shuttingDown) break;

    if (scanId) {
      // There may be more QUEUED scans waiting; poll again immediately
      // instead of sleeping.
      continue;
    }

    await sleep(POLL_MS);
  }

  console.error("[worker] scan worker stopped");
}

main().catch((err) => {
  console.error("[worker] fatal error, exiting", err);
  process.exit(1);
});
