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

  let admin: AdminGraphqlClient;
  try {
    admin = await adminFactory(scan.shop.shopDomain);
  } catch (err) {
    // Poison-pill guard: obtaining the Admin client can fail for reasons
    // outside runScan's own try/catch — most importantly, a shop that
    // uninstalled has had its Session row deleted (by the app/uninstalled
    // webhook) while its still-QUEUED scan is retained, so
    // `unauthenticated.admin(shopDomain)` throws. If we let that propagate,
    // the scan is never advanced out of QUEUED; since we always select the
    // OLDEST QUEUED scan globally, we'd re-select this same broken row on
    // every poll and no other shop's scan could ever run (livelock).
    //
    // So mark THIS scan FAILED ourselves (generic, non-leaking message —
    // the real error is logged server-side only) and RETURN its id, letting
    // the worker treat it as processed and advance to the next scan.
    console.error(
      `[worker-core] admin factory failed for scan ${scan.id} (shop ${scan.shop.shopDomain})`,
      err,
    );
    await prisma.scan.update({
      where: { id: scan.id },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        failureCode: "ADMIN_UNAVAILABLE",
        failureMessageSafe:
          "The scan could not be completed. Please try again.",
      },
    });
    return scan.id;
  }

  await runScan(scan.id, admin, deps);

  return scan.id;
}
