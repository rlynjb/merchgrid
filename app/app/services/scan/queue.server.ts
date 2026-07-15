import type { Scan } from "@prisma/client";
import prisma from "../../db.server";
import { CATALOG_API_VERSION } from "../../config";

/**
 * Thrown by `enqueueScan` when the shop already has a non-terminal scan in
 * flight. Enforces "one active scan per shop" (spec FR-SCAN-002) — callers
 * (e.g. the scan-trigger action) are expected to catch this and surface a
 * friendly "a scan is already running" message rather than letting a second
 * pipeline stomp on the first.
 */
export class ActiveScanError extends Error {}

const ACTIVE_STATUSES = [
  "QUEUED",
  "READING_CATALOG",
  "RUNNING_CHECKS",
  "PREPARING_RESULTS",
] as const;

/**
 * Returns the most recent non-terminal (still in-flight) scan for the shop,
 * or `null` if none exists. "Most recent" only matters if more than one
 * active scan ever existed (which `enqueueScan` itself prevents going
 * forward); ordering by `createdAt` desc keeps the result well-defined
 * regardless.
 */
export async function getActiveScan(shopId: string): Promise<Scan | null> {
  return prisma.scan.findFirst({
    where: { shopId, status: { in: [...ACTIVE_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Enqueues a new scan for the shop, snapshotting the API version and the
 * shop's current minimum-margin setting onto the scan row so a later
 * settings change never retroactively changes what an already-run scan
 * checked against.
 *
 * Throws a plain `Error` if the shop (or its settings) can't be found, and
 * `ActiveScanError` if the shop already has a scan in flight.
 */
export async function enqueueScan(shopId: string): Promise<Scan> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { settings: true },
  });

  if (!shop || !shop.settings) {
    throw new Error(`Cannot enqueue scan: shop or shop settings not found for ${shopId}`);
  }

  // NOTE (TOCTOU): the "is a scan already active" check and the create below
  // are not atomic — under true concurrent requests for the same shop, two
  // callers could both pass the check and both create a scan. This is
  // acceptable for MVP: the API layer serializes requests per merchant
  // session in practice, and there is a single worker process consuming the
  // queue, so a duplicate QUEUED row is a low-probability, low-impact edge
  // case rather than a correctness hazard. Future hardening: a partial
  // unique index (e.g. one row per shopId where status is non-terminal)
  // enforced at the DB level would close this race properly.
  const active = await getActiveScan(shopId);
  if (active) {
    throw new ActiveScanError(
      `Shop ${shopId} already has an active scan (${active.id}, status ${active.status})`,
    );
  }

  return prisma.scan.create({
    data: {
      shopId,
      status: "QUEUED",
      apiVersion: CATALOG_API_VERSION,
      minimumMarginPercentUsed: shop.settings.minimumMarginPercent,
    },
  });
}
