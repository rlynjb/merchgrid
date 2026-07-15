import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  ScanNotFoundError,
  getScanFindings,
  getScanSummary,
} from "../services/scan/scan-api.server";

/**
 * GET /api/scans/:id — scan status, optionally with a page of findings.
 * Thin wrapper: per-shop authorization and all data shaping lives in the
 * service layer, which throws `ScanNotFoundError` for both "no such scan"
 * and "scan belongs to another shop" (mapped to a generic 404 here so we
 * never confirm another tenant's scan id exists).
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const scanId = params.id;

  if (!scanId) {
    return json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const withFindings = url.searchParams.get("withFindings") === "1";
  const pageParam = url.searchParams.get("page");
  const pageSizeParam = url.searchParams.get("pageSize");

  try {
    const summary = await getScanSummary(session.shop, scanId);

    if (!withFindings) {
      return json(summary);
    }

    const findings = await getScanFindings(session.shop, scanId, {
      page: pageParam ? Number(pageParam) : undefined,
      pageSize: pageSizeParam ? Number(pageSizeParam) : undefined,
    });

    return json({ ...summary, findings });
  } catch (error) {
    if (error instanceof ScanNotFoundError) {
      return json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }
};
