import type { AdminGraphqlClient } from "../shopify/catalog-reader.server";
import prisma from "../../db.server";
import { runScan, type RunScanDeps } from "./runner.server";

/**
 * Produces an Admin GraphQL client for a shop identified only by domain —
 * i.e. with no inbound HTTP request to authenticate. Deliberately kept as
 * an injected function (rather than importing `unauthenticated` from
 * `../../shopify.server` here) so this module stays free of any
 * `shopify.server` import: that module calls `shopifyApp()` at load time,
 * which throws under vitest when Shopify OAuth env vars aren't set. The
 * real implementation (see `worker.ts`) wraps
 * `unauthenticated.admin(shopDomain)`.
 */
export type AdminFactory = (shopDomain: string) => Promise<AdminGraphqlClient>;

/**
 * Claims the single oldest QUEUED scan across all shops and runs it to
 * completion (or failure) via `runScan`, returning its id — or `null` if
 * there is no QUEUED scan to claim.
 *
 * Single-worker model: this is intentionally not an atomic
 * claim-then-lock. With exactly one worker process consuming the queue,
 * "find the oldest QUEUED scan" can never race with another claimer. If a
 * second worker process is ever introduced, this needs to become an atomic
 * conditional update (e.g. `UPDATE Scan SET status='READING_CATALOG' WHERE
 * id=? AND status='QUEUED'`, checking the affected-row count) rather than a
 * plain findFirst, to avoid two workers claiming the same scan.
 */
export async function claimAndRunNext(
  adminFactory: AdminFactory,
  deps?: RunScanDeps,
): Promise<string | null> {
  const scan = await prisma.scan.findFirst({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    include: { shop: true },
  });

  if (!scan) {
    return null;
  }

  const admin = await adminFactory(scan.shop.shopDomain);
  await runScan(scan.id, admin, deps);

  return scan.id;
}
