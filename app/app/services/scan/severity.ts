import type { FindingSeverity } from "@merchgrid/catalog-checks";

/**
 * Maps each finding severity to a small integer rank used purely for sort
 * ordering: CRITICAL first, then WARNING, then UNAVAILABLE. This is a
 * host-app presentation/query concern (not part of the check engine's
 * contract), so it lives here rather than in `@merchgrid/catalog-checks`.
 *
 * Persisted verbatim onto `Finding.severityRank` at scan-persist time
 * (see `runner.server.ts`) so the findings table can `ORDER BY` this column
 * in SQL instead of sorting in memory (spec §11.2).
 */
export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  UNAVAILABLE: 2,
};

/**
 * Resolves a severity rank, tolerating unknown/unexpected severity strings
 * (defaults them to the lowest priority) rather than throwing.
 */
export function severityToRank(severity: string): number {
  return SEVERITY_RANK[severity as FindingSeverity] ?? SEVERITY_RANK.UNAVAILABLE;
}

/**
 * Builds the lowercased, space-joined search haystack stored on
 * `Finding.searchText`, so free-text search can run as a SQL
 * case-insensitive `contains` instead of an in-memory filter.
 */
export function buildSearchText(
  parts: Array<string | null | undefined>,
): string {
  return parts
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}
