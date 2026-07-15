import prisma from "../../db.server";
import { enqueueScan } from "./queue.server";
import type { Scan } from "@prisma/client";

/**
 * Thrown whenever the requested scan cannot be returned to the caller —
 * either because no such scan exists, or because it exists but belongs to a
 * different shop. Both cases resolve to this single error (and the routes
 * map it to a generic 404) so the API never confirms or denies that a scan
 * id belongs to some *other* shop. See spec §21.6 / §15.4: per-shop
 * authorization must not leak existence of another tenant's resources.
 */
export class ScanNotFoundError extends Error {}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  WARNING: 1,
  UNAVAILABLE: 2,
};

export interface ScanSummary {
  id: string;
  status: string;
  critical: number;
  warning: number;
  unavailable: number;
  variantsProcessed: number;
  productsProcessed: number;
  partial: boolean;
  minimumMarginPercentUsed: number;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  failureMessageSafe: string | null;
}

export interface FindingRow {
  id: string;
  checkId: string;
  severity: string;
  productId: string;
  variantId: string | null;
  productTitle: string;
  variantTitle: string | null;
  adminUrl: string;
  evidence: Record<string, unknown>;
  explanation: string;
  detectedAt: string;
}

export interface FindingsPage {
  findings: FindingRow[];
  total: number;
  page: number;
  pageSize: number;
}

function toIso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function toScanSummary(scan: Scan): ScanSummary {
  return {
    id: scan.id,
    status: scan.status,
    critical: scan.criticalCount,
    warning: scan.warningCount,
    unavailable: scan.unavailableCount,
    variantsProcessed: scan.variantsProcessed,
    productsProcessed: scan.productsProcessed,
    partial: scan.partial,
    minimumMarginPercentUsed: scan.minimumMarginPercentUsed,
    startedAt: toIso(scan.startedAt),
    completedAt: toIso(scan.completedAt),
    failedAt: toIso(scan.failedAt),
    failureCode: scan.failureCode,
    failureMessageSafe: scan.failureMessageSafe,
  };
}

async function resolveShopOrThrow(shopDomain: string) {
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) {
    throw new ScanNotFoundError(`Unknown shop domain: ${shopDomain}`);
  }
  return shop;
}

/**
 * Loads the scan by id and verifies it belongs to `shop`. Throws
 * `ScanNotFoundError` for both "no such scan" and "scan belongs to another
 * shop" — deliberately the same error/message shape so a caller probing
 * scan ids from another tenant learns nothing.
 */
async function loadOwnedScan(shop: { id: string }, scanId: string) {
  const scan = await prisma.scan.findUnique({ where: { id: scanId } });
  if (!scan || scan.shopId !== shop.id) {
    throw new ScanNotFoundError(`Scan not found: ${scanId}`);
  }
  return scan;
}

/**
 * Resolves the shop by domain and enqueues a new scan for it. Any
 * `ActiveScanError` from `enqueueScan` propagates unchanged so the route can
 * map it to a 409.
 */
export async function startScan(shopDomain: string): Promise<ScanSummary> {
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) {
    throw new Error(`Cannot start scan: unknown shop domain ${shopDomain}`);
  }

  const scan = await enqueueScan(shop.id);
  return toScanSummary(scan);
}

/**
 * Returns the scan summary for `scanId`, enforcing that it belongs to
 * `shopDomain`. Throws `ScanNotFoundError` if the shop domain is unknown,
 * the scan doesn't exist, or the scan belongs to a different shop.
 */
export async function getScanSummary(
  shopDomain: string,
  scanId: string,
): Promise<ScanSummary> {
  const shop = await resolveShopOrThrow(shopDomain);
  const scan = await loadOwnedScan(shop, scanId);
  return toScanSummary(scan);
}

/**
 * Returns a paginated, severity-sorted page of findings for a scan owned by
 * `shopDomain`. Sort order: CRITICAL, then WARNING, then UNAVAILABLE, then
 * checkId ascending. Same per-shop authorization as `getScanSummary`.
 */
export async function getScanFindings(
  shopDomain: string,
  scanId: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<FindingsPage> {
  const shop = await resolveShopOrThrow(shopDomain);
  const scan = await loadOwnedScan(shop, scanId);

  const page = opts.page && opts.page > 0 ? Math.floor(opts.page) : 1;
  const pageSize = Math.min(
    opts.pageSize && opts.pageSize > 0
      ? Math.floor(opts.pageSize)
      : DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );

  const [rows, total] = await Promise.all([
    prisma.finding.findMany({ where: { scanId: scan.id } }),
    prisma.finding.count({ where: { scanId: scan.id } }),
  ]);

  rows.sort((a, b) => {
    const rankDiff =
      (SEVERITY_RANK[a.severity] ?? Number.MAX_SAFE_INTEGER) -
      (SEVERITY_RANK[b.severity] ?? Number.MAX_SAFE_INTEGER);
    if (rankDiff !== 0) return rankDiff;
    return a.checkId.localeCompare(b.checkId);
  });

  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  const findings: FindingRow[] = pageRows.map((f) => ({
    id: f.id,
    checkId: f.checkId,
    severity: f.severity,
    productId: f.productId,
    variantId: f.variantId,
    productTitle: f.productTitle,
    variantTitle: f.variantTitle,
    adminUrl: f.adminUrl,
    evidence: JSON.parse(f.evidenceJson),
    explanation: f.explanation,
    detectedAt: f.detectedAt.toISOString(),
  }));

  return { findings, total, page, pageSize };
}
