import type { AdminGraphqlClient } from "../shopify/catalog-reader.server";
import { readCatalog } from "../shopify/catalog-reader.server";
import { normalizeCatalog } from "@merchgrid/catalog-core";
import { ALL_CHECKS, runChecks } from "@merchgrid/catalog-checks";
import type { CatalogCheckContext } from "@merchgrid/catalog-checks";
import prisma from "../../db.server";
import { assertTransition, type ScanStatus } from "./state";

// The Admin API version this scan pipeline targets. Intentionally NOT
// imported from `app/shopify.server.ts`: that module calls `shopifyApp()`
// at import time, which throws synchronously when `SHOPIFY_APP_URL` (and
// other OAuth config) is unset — as it is in the test environment and in
// any context that only needs to run/verify scans, not serve OAuth. Kept
// as a plain literal here (matching `ApiVersion.July26` = "2026-07") so
// this module has no dependency on the app's OAuth wiring.
const CATALOG_API_VERSION = "2026-07";

const GENERIC_FAILURE_MESSAGE =
  "The scan could not be completed. Please try again.";

export interface RunScanDeps {
  /** Injectable ISO-8601 clock, used only for finding `detectedAt` values, so tests are deterministic. */
  now?: () => string;
}

function defaultNowIso(): string {
  return new Date().toISOString();
}

async function fetchShopCurrencyCode(admin: AdminGraphqlClient): Promise<string> {
  const response = await admin.graphql("{ shop { currencyCode } }");
  const body = await response.json();
  return body?.data?.shop?.currencyCode ?? "USD";
}

/**
 * Runs the full catalog audit pipeline for a single scan: reads the
 * shop's catalog from Shopify, normalizes it, runs the deterministic
 * checks, and persists the resulting findings — moving the scan through
 * its state machine (see `./state`) along the way.
 *
 * Idempotent: calling this again for a scan that already COMPLETED is a
 * no-op. Calling it again for a scan that previously FAILED (reset back
 * to QUEUED by the caller) re-runs the pipeline from scratch and replaces
 * any findings left over from the prior attempt.
 *
 * Failure-safe: any error during the read/normalize/check/persist
 * pipeline is caught, logged server-side with full detail, and recorded
 * on the scan as a FAILED status with a generic, non-leaking
 * `failureMessageSafe` — the underlying error's message is never written
 * to the database or returned to the caller (spec: no internal leakage
 * to end users). A failure never leaves the scan COMPLETED, and never
 * leaves findings from that failed attempt behind (the delete+insert+
 * complete step happens atomically, after the pipeline has already
 * succeeded end-to-end).
 */
export async function runScan(
  scanId: string,
  admin: AdminGraphqlClient,
  deps?: RunScanDeps,
): Promise<void> {
  const scan = await prisma.scan.findUnique({
    where: { id: scanId },
    include: { shop: { include: { settings: true } } },
  });

  if (!scan) {
    throw new Error(`Scan not found: ${scanId}`);
  }

  if (scan.status === "COMPLETED") {
    return;
  }

  const { shop } = scan;
  const { settings } = shop;

  if (!settings) {
    throw new Error(`Shop settings missing for shop ${shop.id}`);
  }

  try {
    assertTransition(scan.status as ScanStatus, "READING_CATALOG");
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: "READING_CATALOG", startedAt: new Date() },
    });

    const currencyCode = await fetchShopCurrencyCode(admin);
    const raw = await readCatalog(admin, {
      variantLimit: settings.catalogVariantLimit,
    });

    assertTransition("READING_CATALOG", "RUNNING_CHECKS");
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: "RUNNING_CHECKS" },
    });

    const snapshot = normalizeCatalog(raw, {
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      currencyCode,
      apiVersion: CATALOG_API_VERSION,
    });

    const ctx: CatalogCheckContext = {
      variants: snapshot.variants,
      settings: { minimumMarginPercent: settings.minimumMarginPercent },
      now: (deps?.now ?? defaultNowIso)(),
    };
    const findings = runChecks(ALL_CHECKS, ctx);

    assertTransition("RUNNING_CHECKS", "PREPARING_RESULTS");
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: "PREPARING_RESULTS" },
    });

    assertTransition("PREPARING_RESULTS", "COMPLETED");

    const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length;
    const warningCount = findings.filter((f) => f.severity === "WARNING").length;
    const unavailableCount = findings.filter((f) => f.severity === "UNAVAILABLE").length;

    const findingRows = findings.map((f) => ({
      scanId,
      shopId: shop.id,
      checkId: f.checkId,
      severity: f.severity,
      productId: f.productId,
      variantId: f.variantId ?? null,
      productTitle: f.productTitle,
      variantTitle: f.variantTitle ?? null,
      adminUrl: f.adminUrl,
      evidenceJson: JSON.stringify(f.evidence),
      explanation: f.explanation,
      detectedAt: new Date(f.detectedAt),
    }));

    // Delete any findings left over from a previous (failed or retried)
    // attempt at this scan, insert the fresh set, and mark the scan
    // COMPLETED — all in one transaction, so a crash partway through
    // can never leave a scan COMPLETED with stale/duplicate findings, or
    // findings persisted without a completed scan to anchor them.
    await prisma.$transaction([
      prisma.finding.deleteMany({ where: { scanId } }),
      ...(findingRows.length > 0
        ? [prisma.finding.createMany({ data: findingRows })]
        : []),
      prisma.scan.update({
        where: { id: scanId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          criticalCount,
          warningCount,
          unavailableCount,
          productsProcessed: snapshot.productsProcessed,
          variantsProcessed: snapshot.variantsProcessed,
          partial: snapshot.partial,
          minimumMarginPercentUsed: settings.minimumMarginPercent,
          apiVersion: CATALOG_API_VERSION,
        },
      }),
    ]);
  } catch (err) {
    // Log the real error server-side only — never expose internals
    // (query text, stack traces, upstream error text) to the scan record
    // or, transitively, to end users (spec section on safe error
    // messaging).
    console.error(`[scan:${scanId}] scan run failed`, err);

    await prisma.scan.update({
      where: { id: scanId },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        failureCode: "SCAN_FAILED",
        failureMessageSafe: GENERIC_FAILURE_MESSAGE,
      },
    });
  }
}
