import { describe, it, expect, vi, afterEach } from "vitest";
import { logEvent } from "../app/services/observability/log-event.server";

describe("logEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs one JSON line with the event name, an ISO timestamp, and extra fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("scan_started", { scanId: "abc123", shopId: "shop_1" });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.event).toBe("scan_started");
    expect(parsed.scanId).toBe("abc123");
    expect(parsed.shopId).toBe("shop_1");
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  it("logs valid JSON with just the event name when data is omitted", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("worker_started");
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.event).toBe("worker_started");
    expect(parsed.ts).toBeDefined();
  });
});
