# MerchGrid: Catalog Audit

**Product specification**  
**Status:** Draft v0.2  
**Date:** July 14, 2026  
**Publisher / parent brand:** Buffr Studio  
**Product family:** MerchGrid  
**App Store name:** MerchGrid: Catalog Audit  
**Brand status:** Working brand selected; formal clearance and registrations pending  
**Platform:** Shopify App Store  
**Product type:** Embedded Shopify admin app  
**Initial operating mode:** Read-only, on-demand catalog scanner

---

## Brand architecture

| Layer | Name | Role |
|---|---|---|
| Parent company / Shopify developer | **Buffr Studio** | Legal, developer, and umbrella identity for software products |
| Ecommerce product family | **MerchGrid** | Customer-facing brand for ecommerce catalog operations |
| First Shopify app | **MerchGrid: Catalog Audit** | Read-only price, margin, SKU, and barcode auditor |
| Future Shopify app | **MerchGrid: Bulk AI** | AI-assisted bulk catalog editing with verification and approval |
| Shared internal technology | **MerchGrid Engine** | Normalization, deterministic checks, severity, evidence, and changeset validation |

### Naming rules

- Use **MerchGrid: Catalog Audit** in the Shopify App Store, legal policies, billing pages, and first-use onboarding.
- Use **MerchGrid** as the short product name inside the app when the context is unambiguous.
- Display **By Buffr Studio** in developer, support, privacy, and company contexts.
- Reserve the `MerchGrid: <Product>` pattern for customer-facing ecommerce apps.
- Do not describe the first app as AI-powered; AI belongs to the future **MerchGrid: Bulk AI** product.
- Keep the shared validation package product-neutral enough to evaluate both current catalog data and future proposed changesets.

---

## 1. Executive summary

MerchGrid: Catalog Audit is the first Shopify app in the MerchGrid ecommerce product family. It detects pricing, margin, SKU, and barcode mistakes without modifying the merchant’s store.

The merchant installs the app, runs an on-demand scan, and receives a prioritized report of potentially expensive or operationally disruptive catalog problems. Examples include products priced below recorded cost, invalid compare-at prices, duplicate SKUs, duplicate barcodes, missing cost data, and suspicious price differences between variants.

The first release intentionally avoids product editing, AI generation, theme integration, storefront scripts, scheduled jobs, and third-party integrations. This keeps the app small, low-risk, and inexpensive to maintain while providing practical Shopify development experience.

MerchGrid: Catalog Audit also serves as the first reusable component of MerchGrid: Bulk AI. Its normalization, validation, severity, reporting, and export logic can later evaluate proposed changes before those changes are written to Shopify.

### Product promise

> Find catalog mistakes that can cost money or disrupt operations—without changing your store.

### Initial merchant outcome

Within a few minutes, a merchant should know:

- Whether any active variants are priced at zero or below cost.
- Whether sale pricing is configured incorrectly.
- Whether SKUs or barcodes are duplicated.
- Whether missing cost or SKU data prevents reliable catalog operations.
- Which exact products and variants require review.

---

## 2. Product strategy

### 2.1 Why this product should be built first

MerchGrid: Catalog Audit is intended to be Buffr Studio’s first Shopify App Store product before building the more complex MerchGrid: Bulk AI app.

It offers a favorable learning-to-risk ratio:

- **Read-only:** The app cannot accidentally overwrite merchant data.
- **Admin-only:** No theme extensions, storefront scripts, or theme compatibility support.
- **On-demand:** No required scheduler, webhook fleet, or permanent background monitoring in the MVP.
- **Deterministic:** Findings come from explicit validation rules rather than an LLM.
- **Product-data focused:** No customer, order, or sensitive personal data is required.
- **Reusable:** The check engine becomes the verification layer of the future bulk editor.

### 2.2 Strategic position

MerchGrid should not compete as a general SEO score, store-launch checklist, or broad “catalog health” app.

It should own a narrower position:

> **Financial and operational catalog integrity for product variants.**

The app concentrates on errors that can lead to lost margin, incorrect sales, inventory confusion, fulfillment mistakes, feed rejection, or reporting inconsistencies.

### 2.3 Long-term product path

```text
MerchGrid: Catalog Audit
Read catalog → normalize data → run checks → rank findings → export report
        │
        ▼
MerchGrid Monitor
Saved rules → scheduled scans → change detection → email alerts → exclusions
        │
        ▼
MerchGrid: Bulk AI
Generate changes → preflight with MerchGrid Engine → approve → write → verify → undo
```

---

## 3. Goals and non-goals

## 3.1 MVP goals

1. Pass Shopify App Store review with a narrowly scoped, understandable product.
2. Let a merchant scan a Shopify catalog without granting write access.
3. Detect a useful initial set of pricing and identifier problems.
4. Present findings in a clear, prioritized interface.
5. Link each finding to the affected product or variant in Shopify admin.
6. Export the complete findings report as CSV.
7. Handle catalogs with incomplete or unusual data without crashing.
8. Create a reusable validation engine for a future bulk-editing product.
9. Learn real merchant catalog patterns and false-positive scenarios.
10. Keep support and infrastructure obligations low.

## 3.2 MVP non-goals

The first release will not:

- Edit products, variants, prices, SKUs, barcodes, or inventory.
- Automatically fix findings.
- Roll back catalog changes.
- Generate product content with AI.
- Provide a natural-language editing interface.
- Scan themes, storefront pages, links, images, or SEO content.
- Modify or evaluate Shopify Markets fixed prices in the initial release.
- Run automatically on a schedule.
- Subscribe to product-change webhooks for continuous monitoring.
- Send Slack, email, or external notifications.
- Integrate with ERPs, PIMs, accounting systems, or marketplaces.
- Access customers, orders, or protected customer information.
- Guarantee that every warning is an error.
- Promise unlimited catalog size before large-catalog behavior is proven.

---

## 4. Target users

## 4.1 Primary persona: Small-to-midsize catalog operator

**Profile**

- Runs or operates a Shopify store with approximately 50 to 5,000 variants.
- Manages products manually or through CSV imports and other apps.
- Does not have a dedicated catalog engineering or data-quality team.
- Wants a quick way to review catalog mistakes.

**Pain points**

- Does not know whether products are accidentally priced below cost.
- Has inconsistent SKU and barcode practices.
- Manually reviews sale prices and variant data.
- Discovers catalog problems only after a customer or fulfillment partner reports them.
- Finds general SEO audits too broad for operational product-data problems.

## 4.2 Secondary persona: Shopify freelancer or agency operator

**Profile**

- Sets up or maintains Shopify stores for clients.
- Performs catalog imports, migrations, or cleanup projects.
- Needs a final validation report before handing a store back to a client.

**Pain points**

- Wants an objective post-import QA checklist.
- Needs evidence that a catalog was reviewed.
- Repeats the same spreadsheet checks for each client.

The agency persona is strategically useful, but multi-store dashboards and agency billing are outside the MVP.

---

## 5. Jobs to be done

### Primary job

> When I have many products or variants in Shopify, help me quickly find pricing and identifier mistakes so I can correct them before they cause lost margin or operational problems.

### Supporting jobs

- When I complete a CSV import, help me validate the result.
- When I prepare a promotion, show me invalid sale pricing.
- When fulfillment or inventory reports look inconsistent, help me find duplicate or missing SKUs.
- When I inherit an existing store, help me assess the quality of its variant data.
- When a catalog contains incomplete cost data, show me what cannot be reliably evaluated.

---

## 6. Value proposition

### Merchant-facing value proposition

MerchGrid gives merchants a fast, read-only audit of pricing and identifier risks inside their Shopify catalog.

### Differentiators

- Focused on financial and operational product-data risks.
- Does not modify store data.
- Findings are deterministic and explainable.
- Findings identify exact products and variants.
- Results are prioritized by severity rather than reduced to a vague score.
- Full report can be exported for cleanup or agency handoff.

### Message hierarchy

1. **Safety:** The app reads product data but never edits it.
2. **Specificity:** It identifies exact variants with exact reasons.
3. **Financial relevance:** It prioritizes below-cost and invalid-price conditions.
4. **Operational relevance:** It detects duplicate or missing identifiers.
5. **Simplicity:** Install, scan, review, export.

---

## 7. MVP scope

## 7.1 Core capabilities

The MVP contains five core capabilities:

1. Shopify installation and authentication.
2. On-demand catalog retrieval.
3. Deterministic check execution.
4. Prioritized results presentation.
5. CSV export.

## 7.2 Supported catalog entities

- Product
- Product variant
- Inventory item fields required for cost evaluation, when available

## 7.3 Required data normalization

The app should transform Shopify API responses into a stable internal representation before running checks.

Suggested normalized variant shape:

```ts
export interface NormalizedVariant {
  shopId: string;
  productId: string;
  productTitle: string;
  productStatus: "ACTIVE" | "DRAFT" | "ARCHIVED" | string;
  productHandle?: string;

  variantId: string;
  variantTitle: string;
  displayName: string;

  price: DecimalValue | null;
  compareAtPrice: DecimalValue | null;
  unitCost: DecimalValue | null;
  currencyCode: string;

  sku: string | null;
  barcode: string | null;

  tracksInventory: boolean;
  inventoryPolicy?: "DENY" | "CONTINUE" | string;
  inventoryQuantity?: number | null;

  adminUrl: string;
}

export interface DecimalValue {
  amount: string;
  currencyCode: string;
}
```

Money calculations must use decimal-safe arithmetic. Floating-point arithmetic must not be used for pricing or margin decisions.

---

## 8. Check pack v1

## 8.1 Severity model

Every finding must use one of the following classifications:

### Critical

The data is objectively inconsistent or presents an obvious financial risk.

Examples:

- Active variant price is zero or negative.
- Selling price is below recorded unit cost.
- Compare-at price is equal to or below selling price when present.

### Warning

The data may be intentional, but it deserves merchant review.

Examples:

- Duplicate SKU.
- Missing SKU on an inventory-tracked variant.
- Variant price is a major outlier within a product.

### Unavailable

A check could not be completed because required data is missing or inaccessible.

Examples:

- Unit cost is missing, so margin cannot be calculated.
- Cost data is unavailable to the current merchant user or app context.

### Passed

The evaluated record did not violate a rule. Passed records do not need to be persisted individually in the MVP; the app may store or display aggregate pass counts.

---

## 8.2 Initial checks

### MG-001: Active variant has zero or negative price

**Severity:** Critical  
**Applies when:** Product is active and variant price is available.  
**Condition:** `price <= 0`  
**Merchant explanation:**

> This active variant is priced at zero or below. Customers may be able to purchase it at an unintended price.

**False-positive considerations:**

- Some merchants intentionally use zero-price products for quotes, samples, deposits, or gated workflows.
- MVP should report the issue but must not claim that it is certainly incorrect.

---

### MG-002: Selling price is below recorded unit cost

**Severity:** Critical  
**Applies when:** Price and unit cost are both available and use the same relevant currency basis.  
**Condition:** `price < unitCost`  
**Calculated fields:**

- Absolute loss per unit: `unitCost - price`
- Gross margin amount: `price - unitCost`
- Gross margin percentage: `(price - unitCost) / price * 100`, when price is greater than zero

**Merchant explanation:**

> This variant is priced below its recorded unit cost. It may lose money before payment, shipping, and operating expenses.

**False-positive considerations:**

- Loss leaders may be intentional.
- Recorded cost may be stale or may exclude/inappropriately include certain expenses.

---

### MG-003: Margin is below merchant threshold

**Severity:** Warning by default; optionally Critical when margin is negative.  
**Applies when:** Price and unit cost are available.  
**Default threshold:** 20%, configurable in app settings.  
**Condition:** `grossMarginPercent < configuredMinimumMarginPercent`  
**Merchant explanation:**

> This variant’s estimated gross margin is below your selected minimum of {threshold}%.

**MVP setting:** Merchant can select a threshold between 0% and 90%.  
**Default behavior:** The first scan may use 20% and clearly label it as an adjustable screening threshold, not business advice.

---

### MG-004: Invalid compare-at price

**Severity:** Critical  
**Applies when:** Compare-at price is present.  
**Condition:** `compareAtPrice <= price`  
**Merchant explanation:**

> The compare-at price should normally be higher than the selling price. This sale configuration may display incorrectly or fail to communicate a valid discount.

---

### MG-005: Duplicate non-empty SKU

**Severity:** Warning  
**Applies when:** SKU is non-empty after trimming and normalization.  
**Condition:** Same normalized SKU appears on more than one variant.  
**Normalization:**

- Trim leading and trailing whitespace.
- Compare case-insensitively for detection.
- Preserve original values for display.

**Merchant explanation:**

> This SKU is also assigned to other variants. Duplicate SKUs can create confusion in inventory, fulfillment, reporting, or external integrations.

**False-positive considerations:**

- Some merchants intentionally reuse SKUs for bundles, packs, duplicate listings, or shared inventory patterns.

---

### MG-006: Duplicate non-empty barcode

**Severity:** Warning  
**Applies when:** Barcode is non-empty after trimming.  
**Condition:** Same normalized barcode appears on more than one variant.  
**Merchant explanation:**

> This barcode is assigned to more than one variant. Duplicate barcodes can cause scanning, marketplace, or fulfillment problems.

**False-positive considerations:**

- Duplicate barcodes may be intentional for equivalent products, although this should still be reviewed.

---

### MG-007: Inventory-tracked variant has no SKU

**Severity:** Warning  
**Applies when:** Inventory tracking is enabled.  
**Condition:** SKU is null, empty, or whitespace.  
**Merchant explanation:**

> This variant tracks inventory but has no SKU. A missing SKU may make fulfillment, inventory reconciliation, and integrations harder to manage.

---

### MG-008: Variant price is an outlier within its product

**Severity:** Warning  
**Applies when:** Product contains enough priced variants for a meaningful comparison.  
**Initial heuristic:**

- Product has at least three variants with positive prices.
- Flag a variant when its price differs from the product median by more than a configurable or fixed multiplier.
- Initial conservative threshold: price is less than 25% of the median or greater than 400% of the median.

**Merchant explanation:**

> This variant’s price is significantly different from the other variants in the same product. Verify that the difference is intentional.

**False-positive considerations:**

- Variant prices may legitimately differ because of size, quantity, material, subscription length, or premium options.
- This check should be labeled as a low-confidence warning.

---

### MG-009: Same SKU has conflicting price or cost data

**Severity:** Warning  
**Applies when:** A duplicate SKU exists.  
**Condition:** Variants sharing a normalized SKU have different prices or recorded costs.  
**Merchant explanation:**

> Variants sharing this SKU have different price or cost values. Verify whether they represent the same inventory item or should use separate SKUs.

---

### MG-010: Unit cost missing

**Severity:** Unavailable  
**Applies when:** Variant can otherwise be evaluated but unit cost is null or unavailable.  
**Merchant explanation:**

> Unit cost is missing or unavailable, so below-cost and margin checks could not be completed for this variant.

**Display guidance:**

- Do not mix this count with Critical issues.
- Present it under “Could not evaluate” or “Incomplete data.”

---

## 8.3 Check engine contract

Each check should be implemented as an independent, testable rule.

```ts
export type FindingSeverity = "CRITICAL" | "WARNING" | "UNAVAILABLE";

export interface CatalogFinding {
  id: string;
  checkId: string;
  severity: FindingSeverity;

  shopId: string;
  productId: string;
  variantId?: string;

  title: string;
  explanation: string;
  evidence: Record<string, string | number | boolean | null>;

  productTitle: string;
  variantTitle?: string;
  adminUrl: string;

  detectedAt: string;
}

export interface CatalogCheck<TContext = CatalogCheckContext> {
  id: string;
  name: string;
  description: string;
  run(context: TContext): Promise<CatalogFinding[]> | CatalogFinding[];
}
```

Checks should not directly call Shopify APIs. Data retrieval and normalization must happen before check execution. This separation allows the same checks to evaluate future proposed changesets in MerchGrid: Bulk AI.

---

## 9. User experience

## 9.1 Primary user flow

```text
Install app
   ↓
Read-only permission explanation
   ↓
Catalog overview and “Run catalog audit”
   ↓
Catalog retrieval and scan progress
   ↓
Results summary
   ↓
Filter and inspect findings
   ↓
Open affected product in Shopify or export CSV
```

## 9.2 Installation and first-run experience

The first screen should state:

> **Check your catalog for pricing and identifier mistakes.**  
> MerchGrid reads your product and variant data but never changes your store.

Primary action:

> **Run catalog audit**

Secondary information:

- What the scan checks.
- Approximate catalog size or number of variants to be evaluated, when available.
- Current scan limit.
- Link to privacy policy.

The app should not force a multi-step onboarding flow before the first scan.

## 9.3 Scan progress

The progress screen should communicate high-level stages rather than unreliable precise percentages.

Example:

```text
Scanning your catalog

✓ Connecting to Shopify
✓ Reading products and variants
• Checking prices, costs, SKUs, and barcodes
○ Preparing your report
```

Required behaviors:

- Prevent accidental duplicate scans from repeated button clicks.
- Allow safe navigation away if the operation is server-managed.
- Recover gracefully if the browser refreshes.
- Provide a clear retry action after failure.

## 9.4 Results dashboard

### Summary cards

```text
Critical issues        12
Warnings               31
Could not evaluate     46
Variants checked     2,417
```

### Highest-priority finding

Show a short callout:

> **7 variants are priced below recorded unit cost.**  
> Review these first because they may create a loss on each sale.

### Findings table

Recommended columns:

| Column | Description |
|---|---|
| Severity | Critical, Warning, or Unavailable |
| Check | Human-readable issue name |
| Product / variant | Product and variant titles |
| Current data | Relevant values such as price, cost, SKU, or barcode |
| Explanation | Why the issue was flagged |
| Action | Open in Shopify |

### Filters

MVP filters:

- Severity
- Check type
- Search by product title, variant title, SKU, or barcode

### Sorting

Default order:

1. Critical
2. Warning
3. Unavailable
4. Within each severity, group by check type or sort by financial magnitude when available

## 9.5 Finding detail

A detail drawer or page should include:

- Product title
- Variant title
- Product status
- Current price
- Compare-at price
- Unit cost, when available
- Gross margin estimate, when calculable
- SKU
- Barcode
- Exact rule that triggered
- Explanation and false-positive note
- Link to open the product or variant in Shopify admin

The MVP will not include a “Fix” button.

## 9.6 CSV export

The CSV export should include:

```text
scan_id
scanned_at
severity
check_id
check_name
product_id
product_title
variant_id
variant_title
product_status
price
compare_at_price
unit_cost
currency
margin_amount
margin_percent
sku
barcode
explanation
admin_url
```

Export requirements:

- Preserve UTF-8 product titles.
- Escape commas, quotes, and line breaks correctly.
- Use an ISO 8601 timestamp.
- Generate export on demand.
- Avoid storing exported files permanently unless operationally necessary.

---

## 10. Functional requirements

## 10.1 Authentication and installation

### FR-AUTH-001

The app must support Shopify installation and embedded admin authentication.

### FR-AUTH-002

The app must request only the minimum scopes required for the MVP.

### FR-AUTH-003

The app must handle uninstall events and remove or deactivate store-specific credentials and retained data according to the app’s retention policy.

### FR-AUTH-004

The app must detect expired or invalid sessions and reauthenticate without exposing internal errors.

---

## 10.2 Catalog retrieval

### FR-DATA-001

The app must retrieve products and variants required for all enabled checks.

### FR-DATA-002

The app must retrieve cost data when available and permitted.

### FR-DATA-003

The app must paginate or use an appropriate bulk-reading strategy for supported catalog sizes.

### FR-DATA-004

The app must normalize empty strings, whitespace, null values, and decimal money values consistently.

### FR-DATA-005

The app must not mutate Shopify catalog data.

### FR-DATA-006

The app must handle products with many variants, unusual option names, archived products, draft products, and missing inventory data.

---

## 10.3 Scan execution

### FR-SCAN-001

The merchant must be able to initiate an on-demand catalog scan.

### FR-SCAN-002

The app must prevent more than one active scan per shop in the MVP.

### FR-SCAN-003

The app must run every enabled check against the same normalized scan snapshot.

### FR-SCAN-004

The app must record scan status as one of:

```text
QUEUED
READING_CATALOG
RUNNING_CHECKS
PREPARING_RESULTS
COMPLETED
FAILED
```

### FR-SCAN-005

The app must record a user-safe failure reason and allow the merchant to retry.

### FR-SCAN-006

A partial retrieval must not be presented as a complete catalog audit. The scan must either clearly report partial completion or fail safely.

---

## 10.4 Findings

### FR-FIND-001

Each finding must contain a check identifier, severity, explanation, evidence, and affected Shopify entity.

### FR-FIND-002

The results view must display aggregate counts by severity.

### FR-FIND-003

The merchant must be able to filter findings by severity and check type.

### FR-FIND-004

The merchant must be able to search findings by product title, variant title, SKU, or barcode.

### FR-FIND-005

Every finding must provide a link to the affected product or variant in Shopify admin when a valid destination can be generated.

### FR-FIND-006

The app must explain that warnings may represent intentional merchant configurations.

---

## 10.5 Settings

### FR-SET-001

The merchant must be able to configure a minimum gross-margin percentage.

### FR-SET-002

The setting must be validated to an allowed range.

### FR-SET-003

Changing the setting does not have to retroactively update old scans; the UI must show the threshold used for each scan.

---

## 10.6 Export

### FR-EXP-001

The merchant must be able to export all findings from a completed scan as CSV.

### FR-EXP-002

The export must respect active filters only if clearly labeled; otherwise the default behavior should export all findings.

### FR-EXP-003

The exported file name should include the shop identifier and scan date in a safe format.

Example:

```text
merchgrid-catalog-audit-findings-2026-07-14.csv
```

---

## 11. Non-functional requirements

## 11.1 Safety

- The app must not request write scopes in the MVP.
- No code path may issue product mutation requests.
- Production credentials must never appear in logs.
- Findings must be framed as review recommendations, not guarantees.

## 11.2 Performance

Initial targets:

- App dashboard loads within 2 seconds under normal conditions, excluding active scan processing.
- A 500-variant catalog should complete in a merchant-acceptable period under normal Shopify API conditions.
- Findings table should remain responsive with at least 5,000 findings through server-side pagination or equivalent techniques.

Exact scan-time promises should not appear in the listing until production measurements are available.

## 11.3 Reliability

- Scan execution must be idempotent by scan identifier.
- Retries must not duplicate findings.
- A failed scan must not overwrite the most recent successful report.
- Database migrations must preserve existing scan history within the stated retention period.

## 11.4 Accessibility

- Primary workflows must be keyboard accessible.
- Severity must not be communicated by color alone.
- Tables and filters must have accessible labels.
- Error messages must describe corrective actions.

## 11.5 Observability

The app should record:

- Installation and uninstall events
- Scan start and completion
- Scan duration
- Catalog size processed
- API failures
- Check execution failures
- Export generation failures
- Billing-state changes, when billing is introduced

Logs must avoid storing complete sensitive catalog payloads unless necessary for debugging and covered by the retention policy.

---

## 12. Data model

Suggested relational model:

### Shop

```text
id
shop_domain
shopify_shop_id
installation_status
access_token_encrypted
installed_at
uninstalled_at
created_at
updated_at
```

### ShopSettings

```text
id
shop_id
minimum_margin_percent
catalog_variant_limit
created_at
updated_at
```

### Scan

```text
id
shop_id
status
api_version
minimum_margin_percent_used
products_processed
variants_processed
critical_count
warning_count
unavailable_count
started_at
completed_at
failed_at
failure_code
failure_message_safe
created_at
updated_at
```

### Finding

```text
id
scan_id
shop_id
check_id
severity
product_id
variant_id
product_title
variant_title
admin_url
evidence_json
explanation
detected_at
created_at
```

### Optional: ScanArtifact

Only needed if catalog retrieval or CSV export requires temporary file storage.

```text
id
scan_id
type
storage_key
expires_at
created_at
```

## 12.1 Retention policy hypothesis

For an early version:

- Keep the latest successful scan and its findings.
- Optionally retain up to three recent scans for debugging and merchant value.
- Delete temporary retrieval artifacts and exports quickly.
- Delete or anonymize retained store data after uninstall according to the privacy policy and applicable requirements.

The exact policy must match the public privacy policy and implemented deletion behavior.

---

## 13. Technical architecture

## 13.1 Suggested components

```text
Embedded Shopify app UI
        │
        ▼
Application server
  ├── Auth/session module
  ├── Scan orchestration service
  ├── Shopify catalog reader
  ├── Normalization layer
  ├── Deterministic check engine
  ├── Findings repository
  ├── CSV export service
  └── Analytics/observability
        │
        ▼
Relational database
```

## 13.2 Suggested repository and package naming

```text
repository:          merchgrid-catalog-audit
Shopify app handle: merchgrid-catalog-audit
internal app ID:    merchgrid_catalog_audit
shared package:     @merchgrid/catalog-core
check package:      @merchgrid/catalog-checks
future changesets:  @merchgrid/changesets
company namespace:  Buffr Studio
```

Public package names and organization handles are availability-dependent and should be reserved before launch. Product logic must not depend on a specific public package registry namespace.

## 13.3 Recommended separation of concerns

### Shopify adapter

Responsible for:

- GraphQL requests
- Pagination or bulk-query coordination
- API error translation
- API version isolation

### Domain normalizer

Responsible for:

- Decimal money representation
- Null and whitespace normalization
- Stable internal product and variant structures
- Building admin URLs

### Check engine

Responsible for:

- Pure or near-pure validation logic
- Severity assignment
- Evidence generation
- No direct Shopify or database dependency

### Scan orchestrator

Responsible for:

- Scan state transitions
- Concurrency control
- Catalog limits
- Retries
- Calling normalization and checks
- Persisting findings

### Presentation layer

Responsible for:

- Result summaries
- Filtering and pagination
- Merchant-safe explanations
- Export initiation

## 13.4 Background processing

Although the merchant initiates scans on demand, catalog reading and check execution should not depend on a single browser request remaining open.

The scan should run as a server-managed job so that:

- Browser refresh does not cancel the scan.
- The merchant can return to the results later.
- Large catalog retrieval can be handled safely.

For the simplest deployment, this may be implemented with a database-backed job state and a modest worker process. The implementation should avoid unnecessary distributed infrastructure before real load requires it.

## 13.5 Catalog-size handling

Initial launch policy:

- Publish a documented maximum number of variants per scan.
- Suggested beta limit: 5,000 variants.
- Clearly count variants, not products, because variant volume drives processing.
- Reject or stop before scanning beyond the limit, with a clear message.

Later versions can increase the limit after testing asynchronous bulk retrieval and large result sets.

---

## 14. Shopify permissions and data boundaries

The MVP should request only product-related read access required for:

- Product and variant information
- Price and compare-at price
- SKU and barcode
- Inventory-tracking metadata
- Unit cost when available through the associated inventory item

The exact scopes and fields must be confirmed against the current Shopify API version during implementation and before App Store submission.

The MVP must not request access to:

- Customers
- Orders
- Checkout data
- Theme modification
- Product write operations
- Inventory write operations

### Permission explanation shown to merchants

> MerchGrid requests read-only product access so it can evaluate prices, costs, SKUs, barcodes, and related variant data. It does not edit products or storefront content.

---

## 15. Privacy and security

### 15.1 Data minimization

Store only the data required to provide scan history and findings.

Avoid retaining complete Shopify catalog payloads after a scan when normalized findings and aggregate metadata are sufficient.

### 15.2 Encryption

- Encrypt Shopify access tokens at rest.
- Use TLS for all network communication.
- Keep secrets outside source control.
- Restrict production database and log access.

### 15.3 Uninstall behavior

On uninstall:

- Revoke or deactivate the shop installation.
- Stop new scans.
- Delete credentials.
- Delete or schedule deletion of retained merchant data according to the published policy.

### 15.4 Security posture

Because the app is read-only, the impact of an application defect is reduced, but unauthorized catalog access remains a serious risk. Authorization must be enforced by shop on every request.

---

## 16. Pricing and packaging

## 16.1 Recommended launch approach

Launch with a generous free beta or free initial plan to gather:

- Real catalog patterns
- False-positive reports
- App review experience
- Installation and onboarding data
- Merchant language for the listing
- Early reviews

Suggested free beta:

```text
Up to 500 variants per scan
All checks
Full findings report
CSV export
Manual rescans
```

## 16.2 Paid-plan hypothesis

Introduce billing only after merchants demonstrate repeated scan behavior or ask for recurring monitoring.

Possible first paid structure:

### Free

- Up to 100 variants
- Summary plus first 10 findings
- Manual scan

### Pro — $4.99/month

- Up to 5,000 variants
- All findings
- Custom margin threshold
- CSV export
- Unlimited manual rescans, subject to reasonable use

### Future Monitor — $14.99 to $19/month

- Scheduled weekly scan
- New-issue detection
- Scan history
- Email summary
- Saved exclusions

Pricing is a hypothesis and should be tested. The strongest recurring value is monitoring over time, not repeatedly charging for the same one-time report.

---

## 17. App Store positioning

## 17.1 App identity

**App name:** MerchGrid: Catalog Audit  
**Developer name:** Buffr Studio  
**Product family:** MerchGrid  
**Future companion app:** MerchGrid: Bulk AI

The App Store name begins with the distinctive ecommerce family brand and then identifies the specific app function. The name must remain consistent between the Shopify app configuration, embedded experience, submission form, support content, and listing assets.

## 17.2 Subtitle

> Find below-cost prices, invalid sales, duplicate SKUs, and barcode errors.

## 17.3 Short description

> MerchGrid scans your Shopify products for pricing and identifier mistakes without changing your store. Find products priced below cost, invalid compare-at prices, duplicate SKUs, duplicate barcodes, missing costs, and suspicious variant prices. Review every affected variant, open it directly in Shopify, and export the complete report as CSV.

## 17.4 Feature bullets

- Detect products priced below recorded cost.
- Find invalid compare-at and sale prices.
- Identify duplicate or missing SKUs.
- Identify duplicate barcodes.
- Review suspicious variant-price differences.
- Export findings as CSV.
- Read-only: MerchGrid never changes product data.

## 17.5 Brand presentation

Recommended listing lockup:

```text
MerchGrid: Catalog Audit
By Buffr Studio
```

Customer-facing brand promise:

> **Safer catalog operations for ecommerce.**

Product-family promise as MerchGrid grows:

> **Inspect, protect, and manage your ecommerce catalog at scale.**

## 17.6 Listing messages to avoid

Do not lead with:

- “Improve your SEO.”
- “Get an AI store score.”
- “Optimize everything automatically.”
- “Guarantee profitable pricing.”
- “Powered by AI” for the first read-only audit app.

Those statements either blur the product’s position, create expectations the MVP does not satisfy, or confuse MerchGrid: Catalog Audit with the future MerchGrid: Bulk AI app.

## 18. Success metrics

## 18.1 Activation

- Percentage of installs that start a scan.
- Percentage of started scans that complete.
- Median time from installation to first completed scan.

## 18.2 Product value

- Percentage of completed scans with at least one Critical finding.
- Percentage with at least one Warning.
- Percentage of users who open an affected product in Shopify.
- Percentage who export CSV.
- Number of repeat scans within 30 days.

## 18.3 Quality

- Scan failure rate.
- Rate of support reports describing a false positive.
- Rate of support reports describing a missed issue.
- Percentage of cost checks marked Unavailable.
- Average findings per 1,000 variants by check type.

## 18.4 Commercial

- Install-to-paid conversion after billing is introduced.
- Monthly recurring revenue.
- Thirty-day and ninety-day retention.
- App Store review count and rating.

## 18.5 MVP success criteria

The MVP should be considered validated when:

- At least 20 real stores complete a scan.
- At least 10 stores produce actionable findings.
- At least 5 merchants perform a second scan or export findings.
- At least 3 merchants explicitly request recurring monitoring, saved history, or automatic alerts.
- Critical false positives remain rare and explainable.

These thresholds are product hypotheses, not guarantees.

---

## 19. Analytics events

Suggested privacy-conscious events:

```text
app_installed
app_uninstalled
scan_started
scan_completed
scan_failed
scan_limit_reached
results_viewed
finding_filtered
product_admin_link_opened
csv_export_started
csv_export_completed
margin_threshold_changed
pricing_page_viewed
plan_selected
```

Event properties may include:

- Shop plan category, when legitimately available and useful
- Variant-count bucket rather than exact catalog data
- Scan duration
- Finding counts by check ID
- App version

Do not send product titles, SKUs, barcodes, prices, or other merchant catalog values to general analytics services.

---

## 20. Support design

The app should reduce support obligations through self-explanatory product design.

### In-product support content

Each check should explain:

- What was detected.
- Which values triggered the rule.
- Why it may matter.
- When the configuration may be intentional.
- How to review the product in Shopify.

### Common support cases

1. “This duplicate SKU is intentional.”
2. “My cost data is missing.”
3. “Why is a zero-price product flagged?”
4. “The scan did not include all variants.”
5. “The app cannot read product costs.”
6. “The scan is taking too long.”
7. “How do I fix the issue?”

The help center should answer these before App Store submission.

### Support boundary

MerchGrid identifies and explains potential issues. The MVP does not provide bookkeeping, pricing strategy, legal, tax, or profitability advice.

---

## 21. Acceptance criteria

## 21.1 Installation

- A merchant can install the app from a Shopify development or production store.
- Requested permissions are read-only and accurately described.
- The app loads inside Shopify admin.
- Uninstall behavior disables access and initiates required cleanup.

## 21.2 Scan

- Merchant can start a scan with one primary action.
- Only one scan per shop can be active.
- Scan state survives page refresh.
- A completed scan reports product and variant counts.
- An incomplete retrieval is not labeled as a successful complete scan.

## 21.3 Checks

For a controlled test catalog, the system correctly detects:

- Active zero-price variant.
- Price below cost.
- Margin below threshold.
- Compare-at price equal to selling price.
- Compare-at price below selling price.
- Duplicate SKU with case and whitespace normalization.
- Duplicate barcode.
- Inventory-tracked variant with missing SKU.
- Deliberate price outlier under the documented heuristic.
- Missing cost as Unavailable rather than Critical.

## 21.4 Results

- Findings are sorted by severity.
- Filtering works by severity and check.
- Search works by title, SKU, and barcode.
- Evidence values match retrieved Shopify data.
- Admin links open the correct product or variant context when supported.
- Warnings include language that they may be intentional.

## 21.5 Export

- CSV contains every finding in the scan.
- UTF-8 characters are preserved.
- Money values and percentages are exported consistently.
- CSV is valid when titles contain commas, quotes, or line breaks.

## 21.6 Safety

- No Shopify mutation exists in the production application path.
- No write scopes are requested.
- A scan never changes product data.
- Shop authorization is enforced on every scan and findings request.

---

## 22. Test plan

## 22.1 Unit tests

- Decimal comparison and margin calculations.
- SKU normalization.
- Barcode normalization.
- Every check with passing, failing, null, and boundary cases.
- Severity assignment.
- CSV escaping.
- Scan state transition rules.

## 22.2 Integration tests

- Shopify authentication and session restoration.
- Product pagination or bulk retrieval.
- Cost-field availability and permission failure.
- Large variant pages.
- Rate-limit and transient API error handling.
- Scan retry without duplicate findings.
- Database cleanup after uninstall.

## 22.3 Test catalog fixtures

Create development-store fixtures that include:

- Active, draft, and archived products.
- Products with one and many variants.
- Zero and negative boundary values where Shopify permits test representation.
- Missing and stale costs.
- Duplicate SKUs differing only by case or whitespace.
- Duplicate barcodes.
- Intentional SKU reuse.
- Products with extreme but legitimate variant price differences.
- Unicode titles and CSV-special characters.
- Thousands of variants for load testing.

## 22.4 Manual QA

- Install and uninstall from a clean store.
- Run first scan.
- Refresh during scan.
- Open results in multiple browser tabs.
- Retry after an induced failure.
- Export and open CSV in common spreadsheet software.
- Verify keyboard navigation and screen-reader labels.

---

## 23. Risks and mitigations

## 23.1 Crowded audit category

**Risk:** Merchants may see the product as another generic store checker.  
**Mitigation:** Keep positioning focused on price, margin, SKU, and barcode integrity. Avoid SEO and broad store scoring.

## 23.2 Weak recurring value

**Risk:** Merchant scans once, fixes issues, and uninstalls.  
**Mitigation:** Treat the first version as platform learning and validation. Add recurring monitoring only after demand is observed.

## 23.3 False positives

**Risk:** Legitimate business configurations are labeled as mistakes.  
**Mitigation:** Use conservative rules, severity distinctions, clear evidence, and “may be intentional” explanations. Reserve Critical for objective inconsistencies or strong financial risk.

## 23.4 Missing cost data

**Risk:** A large portion of catalogs cannot be evaluated for margin.  
**Mitigation:** Treat missing cost as Unavailable, explain how the merchant can add costs, and ensure non-cost checks still provide value.

## 23.5 Large-catalog performance

**Risk:** Pagination, rate limits, or large findings sets cause timeouts.  
**Mitigation:** Use server-managed jobs, publish a beta variant limit, test bulk retrieval, and paginate findings.

## 23.6 Merchant expects fixes

**Risk:** Users assume the app repairs findings automatically.  
**Mitigation:** Repeat “read-only” in onboarding, listing, results, and permissions. Provide direct links to edit products in Shopify.

## 23.7 Low willingness to pay

**Risk:** On-demand scans are perceived as a free utility.  
**Mitigation:** Launch free or low-cost, measure repeat usage, and reserve recurring pricing for scheduled monitoring, history, alerts, and policy features.

## 23.8 API and App Store changes

**Risk:** Shopify requirements, API versions, or field behavior change.  
**Mitigation:** Isolate Shopify access in an adapter, monitor release notes, maintain automated integration tests, and avoid deprecated fields.

---

## 24. Release plan

## Phase 0: Technical spike

Deliverables:

- Shopify app installation and embedded shell.
- Read-only product query.
- Normalized variant model.
- One working rule: invalid compare-at price.
- Development-store report rendered in UI.

Exit criteria:

- Can install, scan a small development catalog, and display correct findings.

## Phase 1: Internal MVP

Deliverables:

- All ten checks.
- Scan orchestration and persistence.
- Summary dashboard and findings table.
- Filters, search, and Shopify admin links.
- Margin threshold setting.
- CSV export.
- Error handling and logs.

Exit criteria:

- Acceptance criteria pass against controlled fixtures.

## Phase 2: Private beta

Deliverables:

- Finalized MerchGrid wordmark and app icon.
- Verified Buffr Studio developer identity and support contact.
- App privacy policy and support documentation.
- Catalog-size guardrail.
- Feedback mechanism.
- False-positive logging process.
- At least five external test stores.

Exit criteria:

- No critical data-safety defects.
- Scan completion rate is acceptable.
- Critical checks are trusted by beta merchants.

## Phase 3: Shopify App Store launch

Deliverables:

- Consistent `MerchGrid: Catalog Audit` naming across app configuration, embedded UI, listing, and support pages.
- Final listing copy and screenshots.
- Billing configuration, if included at launch.
- App review materials.
- Production monitoring.
- Support response templates.

Exit criteria:

- App approved and publicly installable.

## Phase 4: Evidence-led expansion

Only prioritize features supported by real merchant behavior:

- Scheduled scans.
- Scan-to-scan comparison.
- Saved exclusions.
- Email summaries.
- Agency reports.
- Shopify Markets checks.
- Safe fix workflows.

---

## 25. Future roadmap

## 25.1 MerchGrid Monitor

Potential additions:

- Weekly or daily scheduled scans.
- Detect only newly introduced issues.
- Email summaries.
- Scan history and trend reporting.
- Persistent “intentional configuration” exclusions.
- Per-check enable/disable settings.
- Different margin thresholds by product category or tag.
- Agency-friendly PDF or branded report.

## 25.2 Catalog incident monitoring

Potential additions:

- Product-change webhooks.
- Cluster related changes into incidents.
- Detect sudden catalog-wide changes.
- Attribute changes to a user or app when the platform exposes reliable attribution.
- Alert when many products are modified in a short period.

## 25.3 Safe repair workflows

Potential additions:

- Generate a proposed correction CSV.
- Require merchant approval before changes.
- Add narrowly scoped write permissions.
- Maintain before-and-after evidence.
- Support selective rollback.

## 25.4 MerchGrid: Bulk AI integration

The future bulk editor can reuse:

| MerchGrid: Catalog Audit component | MerchGrid: Bulk AI use |
|---|---|
| Shopify catalog reader | Load current store state before generating edits |
| Normalized variant model | Stable input and output format for changesets |
| Check engine | Preflight every proposed edit |
| Severity model | Block critical issues and surface warnings |
| Evidence model | Explain why a proposed change is unsafe |
| Findings UI | Review proposed risks before approval |
| CSV export | Export proposed or rejected changes |
| Margin settings | Standing guardrails for bulk jobs |

Future flow:

```text
Merchant prompt or CSV
        ↓
Proposed changeset
        ↓
MerchGrid Engine
        ↓
Critical issues blocked
Warnings require review
        ↓
Merchant approval
        ↓
Shopify write operation
        ↓
Post-write verification
```

---

## 26. Open product questions

These questions should be answered through beta usage rather than prolonged speculation:

1. Do merchants care more about pricing risk or duplicate identifiers?
2. How often are unit costs present and usable?
3. What catalog sizes install the app most often?
4. Is a margin threshold understandable without onboarding assistance?
5. Which warnings create the most false-positive complaints?
6. Do agencies value CSV export more than direct merchants?
7. Will merchants rerun scans after imports or promotions?
8. Which recurring feature creates willingness to pay: scheduling, history, alerts, or saved rules?
9. Should archived and draft products be included by default?
10. Is variant price-outlier detection useful enough to retain?
11. Is the first paid plan better priced per store, catalog size, or monitoring frequency?
12. Do merchants want the future bulk editor inside the same app or as a separate App Store listing?

---

## 27. Build decision

Proceed with MerchGrid: Catalog Audit as the first Shopify App Store product published by Buffr Studio under the following constraints:

- Keep the MVP read-only.
- Focus the listing on price, margin, SKU, and barcode risks.
- Avoid general SEO and broad store-health positioning.
- Use deterministic checks rather than AI.
- Publish a conservative catalog-size limit.
- Make every finding explainable.
- Treat missing data as Unavailable rather than an error.
- Delay scheduling and write access until real merchant demand is demonstrated.
- Design the check engine as a reusable package for the future MerchGrid: Bulk AI product.

### Final product statement

> **MerchGrid: Catalog Audit is a read-only Shopify catalog auditor by Buffr Studio that finds pricing, margin, SKU, and barcode risks, explains every finding, and helps merchants review affected variants without changing store data.**
