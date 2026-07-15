/**
 * Small, env-free config constants shared across the app.
 *
 * Deliberately dependency-free (no `shopifyApp()` call, no env reads) so it
 * can be imported by server modules — like the scan runner — that must load
 * in contexts where the full Shopify OAuth config is not present (tests,
 * background jobs).
 */

/**
 * The Shopify Admin API version the catalog audit pipeline targets.
 *
 * Keep in sync with:
 *   - `api_version` in `shopify.app.toml`
 *   - `ApiVersion.July26` used in `app/shopify.server.ts`
 * (We can't import that enum here: `shopify.server.ts` calls `shopifyApp()`
 * at module load, which throws when OAuth env vars are unset.)
 */
export const CATALOG_API_VERSION = "2026-07";
