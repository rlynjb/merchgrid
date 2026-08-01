/**
 * Writes one structured JSON line to stdout for every scan-lifecycle /
 * worker-lifecycle event, so production issues ("my scan has been loading
 * for ten minutes") are answerable by grepping `fly logs` for a scanId or
 * shopId, without reproducing locally.
 */
export function logEvent(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}
