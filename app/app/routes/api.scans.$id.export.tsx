import type { LoaderFunctionArgs } from "@remix-run/node";
import { ALL_CHECKS } from "@merchgrid/catalog-checks";
import { authenticate } from "../shopify.server";
import {
  ScanNotFoundError,
  getAllFindingsForExport,
} from "../services/scan/scan-api.server";
import { buildFindingsCsv } from "../services/scan/export.server";

const CHECK_NAMES: Record<string, string> = Object.fromEntries(
  ALL_CHECKS.map((check) => [check.id, check.name]),
);

/**
 * GET /api/scans/:id/export — downloads the completed scan's findings as a
 * CSV (spec §9.6). Thin wrapper: per-shop authorization and data loading
 * live in `getAllFindingsForExport`, formatting lives in the pure
 * `buildFindingsCsv`. Mirrors `api.scans.$id.tsx`'s handling of
 * `ScanNotFoundError` as a generic 404 so another tenant's scan id is never
 * confirmed to exist.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const scanId = params.id;

  if (!scanId) {
    throw new Response("Not found", { status: 404 });
  }

  let summary;
  let findings;
  try {
    ({ summary, findings } = await getAllFindingsForExport(
      session.shop,
      scanId,
    ));
  } catch (error) {
    if (error instanceof ScanNotFoundError) {
      throw new Response("Not found", { status: 404 });
    }
    throw error;
  }

  const scannedAt = summary.completedAt ?? new Date().toISOString();
  const csv = buildFindingsCsv(
    findings,
    { scanId: summary.id, scannedAt },
    CHECK_NAMES,
  );

  const safeShop = session.shop.replace(/\./g, "-");
  const datePart = scannedAt.slice(0, 10);
  const filename = `merchgrid-catalog-audit-findings-${safeShop}-${datePart}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
