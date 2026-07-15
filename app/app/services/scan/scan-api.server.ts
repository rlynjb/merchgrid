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

/**
 * Thrown by `getAllFindingsForExport` when the caller owns the scan but it
 * hasn't reached `COMPLETED` yet. A non-completed scan's findings are still
 * being written (or don't exist yet), so exporting it now would produce a
 * misleading CSV — e.g. `scannedAt` falling back to "now" instead of the
 * scan's actual completion time. Checked *after* ownership (see
 * `loadOwnedScan`) so a wrong-shop request still resolves to
 * `ScanNotFoundError`, never leaking another tenant's scan status.
 */
export class ScanNotCompletedError extends Error {}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

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
 * Resolves the shop by domain and enqueues a new scan for it. Throws
 * `ScanNotFoundError` if the shop domain doesn't resolve to a known shop
 * (defensive/unreachable in practice: `authenticate.admin` implies the Shop
 * row already exists) so the route can map it to a 404 instead of an
 * unhandled 500. Any `ActiveScanError` from `enqueueScan` propagates
 * unchanged so the route can map it to a 409.
 */
export async function startScan(shopDomain: string): Promise<ScanSummary> {
  const shop = await resolveShopOrThrow(shopDomain);

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
  const search = opts.search?.trim().toLowerCase();
  if (search) {
    // `searchText` is a lowercased, space-joined concatenation of
    // productTitle/variantTitle/sku/barcode, populated at persist time (see
    // runner.server.ts). Lowercasing the query here + the stored column at
    // write time gives us case-insensitive search via SQLite's
    // case-sensitive `contains` (spec §11.2: no in-memory filtering).
    where.searchText = { contains: search };
  }

  const total = await prisma.finding.count({ where });
  const rows = await prisma.finding.findMany({
    where,
    orderBy: [{ severityRank: "asc" }, { checkId: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  const findings: FindingRow[] = rows.map(toFindingRow);

  return { findings, total, page, pageSize };
}

/**
 * Returns the scan summary plus every one of its findings — no pagination —
 * severity-sorted the same way as `getScanFindings`. Used by the CSV export
 * route, which needs the full result set in one shot. Same per-shop
 * authorization as `getScanSummary`, checked *before* the completion gate so
 * a wrong-owner request still gets `ScanNotFoundError` and never learns
 * whether some other shop's scan has finished. Throws
 * `ScanNotCompletedError` if the (owned) scan hasn't reached `COMPLETED` yet.
 */
export async function getAllFindingsForExport(
  shopDomain: string,
  scanId: string,
): Promise<{ summary: ScanSummary; findings: FindingRow[] }> {
  const shop = await resolveShopOrThrow(shopDomain);
  const scan = await loadOwnedScan(shop, scanId);

  if (scan.status !== "COMPLETED") {
    throw new ScanNotCompletedError(`Scan not completed: ${scanId}`);
  }

  const rows = await prisma.finding.findMany({
    where: { scanId: scan.id },
    orderBy: [{ severityRank: "asc" }, { checkId: "asc" }],
  });
  const findings: FindingRow[] = rows.map(toFindingRow);

  return { summary: toScanSummary(scan), findings };
}
