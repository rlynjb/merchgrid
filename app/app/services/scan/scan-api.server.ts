import prisma from "../../db.server";
import { enqueueScan, getActiveScan } from "./queue.server";
import type { Prisma, Scan } from "@prisma/client";
import { formatMoney, marginAmount, marginPercent } from "@merchgrid/catalog-checks";

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
  price: string | null;
  compareAtPrice: string | null;
  unitCost: string | null;
  currency: string | null;
  sku: string | null;
  barcode: string | null;
  productStatus: string | null;
  marginAmount: string | null;
  marginPercent: number | null;
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
 * Returns the summary of the shop's currently active (non-terminal) scan, if
 * any. Resolves `shopDomain` to a shop first; an unknown domain (or a shop
 * with no active scan) both resolve to `null` rather than throwing, since
 * this is used by UI code that just wants to know whether to link to an
 * in-progress scan.
 */
export async function getActiveScanForShop(
  shopDomain: string,
): Promise<ScanSummary | null> {
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) {
    return null;
  }

  const scan = await getActiveScan(shop.id);
  return scan ? toScanSummary(scan) : null;
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

function toFindingRow(f: {
  id: string;
  checkId: string;
  severity: string;
  productId: string;
  variantId: string | null;
  productTitle: string;
  variantTitle: string | null;
  adminUrl: string;
  evidenceJson: string;
  explanation: string;
  detectedAt: Date;
  price: string | null;
  compareAtPrice: string | null;
  unitCost: string | null;
  currencyCode: string | null;
  sku: string | null;
  barcode: string | null;
  productStatus: string | null;
}): FindingRow {
  const hasMarginInputs = f.price !== null && f.unitCost !== null;

  return {
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
    price: f.price,
    compareAtPrice: f.compareAtPrice,
    unitCost: f.unitCost,
    currency: f.currencyCode,
    sku: f.sku,
    barcode: f.barcode,
    productStatus: f.productStatus,
    marginAmount: hasMarginInputs
      ? formatMoney(marginAmount(f.price!, f.unitCost!))
      : null,
    marginPercent: hasMarginInputs
      ? marginPercent(f.price!, f.unitCost!)
      : null,
  };
}

function sortBySeverityThenCheckId<T extends { severity: string; checkId: string }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const rankDiff =
      (SEVERITY_RANK[a.severity] ?? Number.MAX_SAFE_INTEGER) -
      (SEVERITY_RANK[b.severity] ?? Number.MAX_SAFE_INTEGER);
    if (rankDiff !== 0) return rankDiff;
    return a.checkId.localeCompare(b.checkId);
  });
}

/**
 * Returns a paginated, severity-sorted page of findings for a scan owned by
 * `shopDomain`. Sort order: CRITICAL, then WARNING, then UNAVAILABLE, then
 * checkId ascending. Same per-shop authorization as `getScanSummary`.
 */
export async function getScanFindings(
  shopDomain: string,
  scanId: string,
  opts: {
    page?: number;
    pageSize?: number;
    severity?: string;
    checkId?: string;
    search?: string;
  } = {},
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

  const where: Prisma.FindingWhereInput = { scanId: scan.id };
  if (opts.severity) {
    where.severity = opts.severity;
  }
  if (opts.checkId) {
    where.checkId = opts.checkId;
  }

  const rows = await prisma.finding.findMany({ where });

  const search = opts.search?.trim().toLowerCase();
  const filteredRows = search
    ? rows.filter((row) => {
        const haystacks = [
          row.productTitle,
          row.variantTitle,
          row.sku,
          row.barcode,
        ];
        return haystacks.some(
          (value) => value != null && value.toLowerCase().includes(search),
        );
      })
    : rows;

  const total = filteredRows.length;
  const sorted = sortBySeverityThenCheckId(filteredRows);

  const start = (page - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  const findings: FindingRow[] = pageRows.map(toFindingRow);

  return { findings, total, page, pageSize };
}

/**
 * Returns the scan summary plus every one of its findings — no pagination —
 * severity-sorted the same way as `getScanFindings`. Used by the CSV export
 * route, which needs the full result set in one shot. Same per-shop
 * authorization as `getScanSummary`.
 */
export async function getAllFindingsForExport(
  shopDomain: string,
  scanId: string,
): Promise<{ summary: ScanSummary; findings: FindingRow[] }> {
  const shop = await resolveShopOrThrow(shopDomain);
  const scan = await loadOwnedScan(shop, scanId);

  const rows = await prisma.finding.findMany({ where: { scanId: scan.id } });
  const sorted = sortBySeverityThenCheckId(rows);
  const findings: FindingRow[] = sorted.map(toFindingRow);

  return { summary: toScanSummary(scan), findings };
}
