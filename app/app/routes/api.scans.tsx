import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { ActiveScanError } from "../services/scan/queue.server";
import { ScanNotFoundError, startScan } from "../services/scan/scan-api.server";

/**
 * POST /api/scans — enqueue a new catalog audit scan for the authenticated
 * shop. Thin wrapper: all logic (shop resolution, enqueue, one-active-scan
 * enforcement) lives in the service layer.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const scan = await startScan(session.shop);
    return json(scan, { status: 202 });
  } catch (error) {
    if (error instanceof ActiveScanError) {
      return json(
        { error: "A scan is already running for this shop." },
        { status: 409 },
      );
    }
    if (error instanceof ScanNotFoundError) {
      return json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }
};
