/**
 * MerchGrid Catalog Audit — dev-store fixture seeder
 * ===================================================
 *
 * STANDALONE script, NOT part of the app runtime. It talks directly to the
 * Shopify Admin GraphQL API using its OWN write-scoped Admin API access
 * token (`FIXTURE_ADMIN_TOKEN`), supplied only via environment variables.
 *
 * It NEVER uses the MerchGrid app's session/OAuth credentials. The app
 * itself is read-only (`read_products,read_inventory` — see
 * `shopify.app.toml`) and must never import anything from `app/scripts/`.
 * This file must never be imported from `app/app/**`.
 *
 * Usage:
 *   FIXTURE_SHOP=your-dev-store.myshopify.com \
 *   FIXTURE_ADMIN_TOKEN=shpat_xxx \
 *   npx tsx scripts/seed-fixtures.ts              # clean + seed the full fixture set
 *
 *   FIXTURE_SHOP=... FIXTURE_ADMIN_TOKEN=... \
 *   npx tsx scripts/seed-fixtures.ts --clean       # delete fixtures only
 *
 * Or via the npm scripts wired in package.json:
 *   npm run seed:fixtures
 *   npm run seed:fixtures:clean
 *
 * Every fixture product is tagged `merchgrid-fixture` so it can always be
 * identified and safely cleaned up without touching any other product in
 * the store. `--clean` (and the pre-seed cleanup step of a default run)
 * ONLY ever queries and deletes products carrying that tag.
 *
 * Fixture -> check mapping
 * ------------------------
 *   MG-001  Free Sample                                  zero price, ACTIVE variant
 *   MG-002  Below-Cost Tee                                price < unit cost
 *           Archived Below-Cost                           price < unit cost (no status gate — see below)
 *           Café ☕ "Ünïcode", Newline Tee                 price < unit cost (CSV-escaping stress title)
 *   MG-003  Thin-Margin Mug                               margin (15%) below default 20% threshold
 *   MG-004  Bad-Sale Hoodie                                compareAtPrice < price            → CRITICAL
 *           No-Discount Cap                                compareAtPrice == price            → WARNING
 *   MG-005  Shared SKU A / Shared SKU B                   duplicate normalized SKU (case + whitespace)
 *   MG-006  Dup Barcode X / Dup Barcode Y                 duplicate barcode
 *   MG-007  Tracked No-SKU                                 inventory-tracked variant, no SKU
 *   MG-008  Variant-Outlier Shirt                          Large variant >4x the product's median price
 *   MG-009  Shared SKU A / Shared SKU B                   same normalized SKU, conflicting price/cost
 *   MG-010  Missing-Cost Item                              unit cost not recorded (unavailable)
 *
 *   Draft Zero-Price (DRAFT, price "0.00") must NOT trigger MG-001 — proves
 *   the active-only gate on that check.
 *   Archived Below-Cost (ARCHIVED, price < cost) DOES still trigger MG-002 —
 *   MG-002 has no status gate; this fixture documents that intentionally.
 *
 * API-shape assumptions made against the 2026-07 Admin GraphQL schema
 * (validate these on the first live run against a real dev store):
 *   - `productCreate` takes a `product: ProductCreateInput!` argument (the
 *     older `input: ProductInput` argument is deprecated).
 *   - SKU / unit cost / tracked live under `inventoryItem: InventoryItemInput`
 *     (fields `sku`, `cost`, `tracked`) on `ProductVariantsBulkInput`, not as
 *     top-level variant fields.
 *   - `productVariantsBulkCreate(..., strategy: REMOVE_STANDALONE_VARIANT)`
 *     removes the default variant `productCreate` auto-creates, in the same
 *     call that creates our real variant(s) — no separate delete step needed.
 *   - `optionValues` is optional on `ProductVariantsBulkInput` for
 *     single-option products, so every fixture except "Variant-Outlier
 *     Shirt" omits `productOptions` / `optionValues` entirely and relies on
 *     Shopify's default "Title" / "Default Title" option+value.
 *   - Products are located for cleanup via the search query `tag:merchgrid-fixture`.
 */

import "dotenv/config";

const FIXTURE_TAG = "merchgrid-fixture";
const API_VERSION = "2026-07"; // keep in sync with shopify.app.toml / app/config.ts CATALOG_API_VERSION

// ---------------------------------------------------------------------------
// Env / config
// ---------------------------------------------------------------------------

function printMissingEnvHelp(): void {
  console.error(
    [
      "",
      "Missing FIXTURE_SHOP and/or FIXTURE_ADMIN_TOKEN environment variables.",
      "",
      "This script is a STANDALONE dev-store seeder. It needs its own",
      "write-scoped Admin API token — it never reuses the MerchGrid app's",
      "(read-only) credentials.",
      "",
      "To get one:",
      "  1. In your Shopify dev store admin, go to",
      "     Settings -> Apps and sales channels -> Develop apps.",
      '  2. Click "Create an app" (any name, e.g. "fixture-seeder").',
      "  3. Configure Admin API scopes: enable write_products and the",
      "     inventory scopes (read_inventory, write_inventory).",
      "  4. Click Install, then reveal the Admin API access token.",
      "",
      "Then run:",
      "  FIXTURE_SHOP=your-dev-store.myshopify.com \\",
      "  FIXTURE_ADMIN_TOKEN=shpat_xxx \\",
      "  npm run seed:fixtures",
      "",
      "Never commit this token. It is read from the environment only.",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// GraphQL client
// ---------------------------------------------------------------------------

interface UserError {
  field: string[] | null;
  message: string;
}

interface GraphQLResponseBody<T> {
  data?: T;
  errors?: { message: string }[];
}

function assertNoUserErrors(userErrors: UserError[], context: string): void {
  if (userErrors.length > 0) {
    throw new Error(
      `${context} returned userErrors: ${userErrors
        .map((e) => `${(e.field ?? []).join(".") || "(no field)"}: ${e.message}`)
        .join("; ")}`,
    );
  }
}

class FixtureShopifyClient {
  constructor(
    private readonly shop: string,
    private readonly token: string,
  ) {}

  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const url = `https://${this.shop}/admin/api/${API_VERSION}/graphql.json`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": this.token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const bodyText = await res.text();
      throw new Error(
        `Shopify Admin API request failed: HTTP ${res.status} ${res.statusText} — ${bodyText}`,
      );
    }

    const body = (await res.json()) as GraphQLResponseBody<T>;

    if (body.errors && body.errors.length > 0) {
      throw new Error(
        `Shopify Admin API returned GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }

    if (body.data === undefined) {
      throw new Error("Shopify Admin API response was missing a `data` field.");
    }

    return body.data;
  }
}

// ---------------------------------------------------------------------------
// Fixture data model
// ---------------------------------------------------------------------------

interface VariantOptionValue {
  optionName: string;
  name: string;
}

interface VariantFixture {
  price: string;
  compareAtPrice?: string;
  barcode?: string;
  sku?: string;
  cost?: string;
  tracked?: boolean;
  optionValues?: VariantOptionValue[];
}

interface ProductOptionFixture {
  name: string;
  values: { name: string }[];
}

type ProductStatusFixture = "ACTIVE" | "DRAFT" | "ARCHIVED";

interface ProductFixture {
  title: string;
  status: ProductStatusFixture;
  triggers: string;
  productOptions?: ProductOptionFixture[];
  variants: VariantFixture[];
}

const SIZE_OPTION: ProductOptionFixture = {
  name: "Size",
  values: [{ name: "Small" }, { name: "Medium" }, { name: "Large" }],
};

const FIXTURES: ProductFixture[] = [
  {
    title: "Below-Cost Tee",
    status: "ACTIVE",
    triggers: "MG-002",
    variants: [{ price: "8.00", sku: "BC-001", cost: "10.00", tracked: true }],
  },
  {
    title: "Thin-Margin Mug",
    status: "ACTIVE",
    triggers: "MG-003",
    variants: [{ price: "10.00", sku: "TM-001", cost: "8.50", tracked: true }],
  },
  {
    title: "Free Sample",
    status: "ACTIVE",
    triggers: "MG-001",
    variants: [{ price: "0.00", sku: "FS-001" }],
  },
  {
    title: "Bad-Sale Hoodie",
    status: "ACTIVE",
    triggers: "MG-004 (critical)",
    variants: [{ price: "10.00", compareAtPrice: "9.00", sku: "BS-001" }],
  },
  {
    title: "No-Discount Cap",
    status: "ACTIVE",
    triggers: "MG-004 (warning)",
    variants: [{ price: "20.00", compareAtPrice: "20.00", sku: "ND-001" }],
  },
  {
    title: "Shared SKU A",
    status: "ACTIVE",
    triggers: "MG-005, MG-009",
    variants: [{ price: "10.00", sku: "SHARED-SKU", cost: "5.00" }],
  },
  {
    title: "Shared SKU B",
    status: "ACTIVE",
    triggers: "MG-005, MG-009",
    // Whitespace + different case vs "Shared SKU A" — same fixture ID (SKU)
    // once normalized (trim + lowercase), per catalog-checks normalizeSku().
    variants: [{ price: "12.00", sku: " shared-sku ", cost: "6.00" }],
  },
  {
    title: "Dup Barcode X",
    status: "ACTIVE",
    triggers: "MG-006",
    variants: [{ price: "15.00", sku: "DBX-001", barcode: "0123456789012" }],
  },
  {
    title: "Dup Barcode Y",
    status: "ACTIVE",
    triggers: "MG-006",
    variants: [{ price: "15.00", sku: "DBY-001", barcode: "0123456789012" }],
  },
  {
    title: "Tracked No-SKU",
    status: "ACTIVE",
    triggers: "MG-007",
    // No `sku` set at all — omitted, not empty string, so it reads back as
    // null from InventoryItem.sku.
    variants: [{ price: "15.00", tracked: true }],
  },
  {
    title: "Variant-Outlier Shirt",
    status: "ACTIVE",
    triggers: "MG-008",
    productOptions: [SIZE_OPTION],
    variants: [
      { price: "10.00", sku: "VOS-S", optionValues: [{ optionName: "Size", name: "Small" }] },
      { price: "11.00", sku: "VOS-M", optionValues: [{ optionName: "Size", name: "Medium" }] },
      // Median of [10, 11, 100] is 11; 100 > 4 * 11, so Large is the outlier.
      { price: "100.00", sku: "VOS-L", optionValues: [{ optionName: "Size", name: "Large" }] },
    ],
  },
  {
    title: "Missing-Cost Item",
    status: "ACTIVE",
    triggers: "MG-010",
    // No `cost` set — inventoryItem.cost omitted entirely.
    variants: [{ price: "25.00", sku: "MC-001" }],
  },
  {
    title: 'Café ☕ "Ünïcode", Newline Tee',
    status: "ACTIVE",
    triggers: "MG-002 (CSV escaping stress: comma, double-quote, unicode in title)",
    // A literal newline in a product title is rejected by the Admin API, so
    // this fixture stresses comma + double-quote + unicode instead, per the
    // task's fallback note.
    variants: [{ price: "3.00", sku: "UNI-001", cost: "6.00" }],
  },
  {
    title: "Draft Zero-Price",
    status: "DRAFT",
    triggers: "none expected (proves MG-001's active-only gate)",
    variants: [{ price: "0.00", sku: "DZ-001" }],
  },
  {
    title: "Archived Below-Cost",
    status: "ARCHIVED",
    triggers: "MG-002 (documents: no status gate on MG-002)",
    variants: [{ price: "5.00", sku: "AR-001", cost: "10.00" }],
  },
];

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const PRODUCT_CREATE_MUTATION = `#graphql
  mutation CreateFixtureProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id title }
      userErrors { field message }
    }
  }
`;

interface ProductCreateResponse {
  productCreate: {
    product: { id: string; title: string } | null;
    userErrors: UserError[];
  };
}

const VARIANTS_BULK_CREATE_MUTATION = `#graphql
  mutation CreateFixtureVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(
      productId: $productId
      variants: $variants
      strategy: REMOVE_STANDALONE_VARIANT
    ) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

interface VariantsBulkCreateResponse {
  productVariantsBulkCreate: {
    productVariants: { id: string }[];
    userErrors: UserError[];
  };
}

const PRODUCTS_BY_TAG_QUERY = `#graphql
  query FixtureProducts($searchQuery: String!, $cursor: String) {
    products(first: 100, after: $cursor, query: $searchQuery) {
      pageInfo { hasNextPage endCursor }
      nodes { id title }
    }
  }
`;

interface ProductsByTagResponse {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { id: string; title: string }[];
  };
}

const PRODUCT_DELETE_MUTATION = `#graphql
  mutation DeleteFixtureProduct($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

interface ProductDeleteResponse {
  productDelete: {
    deletedProductId: string | null;
    userErrors: UserError[];
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function buildVariantInput(v: VariantFixture): Record<string, unknown> {
  const inventoryItem: Record<string, unknown> = {};
  if (v.sku !== undefined) inventoryItem.sku = v.sku;
  if (v.cost !== undefined) inventoryItem.cost = v.cost;
  if (v.tracked !== undefined) inventoryItem.tracked = v.tracked;

  const variantInput: Record<string, unknown> = { price: v.price };
  if (v.compareAtPrice !== undefined) variantInput.compareAtPrice = v.compareAtPrice;
  if (v.barcode !== undefined) variantInput.barcode = v.barcode;
  if (Object.keys(inventoryItem).length > 0) variantInput.inventoryItem = inventoryItem;
  if (v.optionValues !== undefined) variantInput.optionValues = v.optionValues;
  return variantInput;
}

async function createFixtureProduct(
  client: FixtureShopifyClient,
  fixture: ProductFixture,
): Promise<{ id: string; title: string; triggers: string }> {
  const productInput: Record<string, unknown> = {
    title: fixture.title,
    status: fixture.status,
    tags: [FIXTURE_TAG],
  };
  if (fixture.productOptions) productInput.productOptions = fixture.productOptions;

  const createData = await client.request<ProductCreateResponse>(PRODUCT_CREATE_MUTATION, {
    product: productInput,
  });
  assertNoUserErrors(createData.productCreate.userErrors, `productCreate("${fixture.title}")`);
  const product = createData.productCreate.product;
  if (!product) {
    throw new Error(`productCreate("${fixture.title}") returned no product and no userErrors.`);
  }

  const variantsInput = fixture.variants.map(buildVariantInput);
  const variantData = await client.request<VariantsBulkCreateResponse>(
    VARIANTS_BULK_CREATE_MUTATION,
    { productId: product.id, variants: variantsInput },
  );
  assertNoUserErrors(
    variantData.productVariantsBulkCreate.userErrors,
    `productVariantsBulkCreate("${fixture.title}")`,
  );

  console.log(`Created: "${fixture.title}" (${product.id}) — ${fixture.triggers}`);
  return { id: product.id, title: fixture.title, triggers: fixture.triggers };
}

async function findFixtureProducts(
  client: FixtureShopifyClient,
): Promise<{ id: string; title: string }[]> {
  const found: { id: string; title: string }[] = [];
  let cursor: string | undefined;

  for (;;) {
    const data = await client.request<ProductsByTagResponse>(PRODUCTS_BY_TAG_QUERY, {
      searchQuery: `tag:${FIXTURE_TAG}`,
      cursor,
    });
    found.push(...data.products.nodes);
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor ?? undefined;
  }

  return found;
}

async function cleanFixtures(client: FixtureShopifyClient): Promise<number> {
  const products = await findFixtureProducts(client);

  for (const product of products) {
    const data = await client.request<ProductDeleteResponse>(PRODUCT_DELETE_MUTATION, {
      input: { id: product.id },
    });
    assertNoUserErrors(data.productDelete.userErrors, `productDelete("${product.title}")`);
    console.log(`Deleted: "${product.title}" (${product.id})`);
  }

  return products.length;
}

function printSummary(created: { title: string; id: string; triggers: string }[]): void {
  console.log("\nFixture seed summary:");
  console.table(
    created.map((c) => ({
      Title: c.title,
      "Product ID": c.id,
      Triggers: c.triggers,
    })),
  );
  console.log(`\n${created.length} fixture product(s) created, all tagged "${FIXTURE_TAG}".`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const shop = process.env.FIXTURE_SHOP;
  const token = process.env.FIXTURE_ADMIN_TOKEN;

  if (!shop || !token) {
    printMissingEnvHelp();
    process.exit(1);
    return;
  }

  const client = new FixtureShopifyClient(shop, token);
  const cleanOnly = process.argv.includes("--clean");

  if (cleanOnly) {
    console.log(`Cleaning fixtures tagged "${FIXTURE_TAG}" from ${shop}...`);
    const deleted = await cleanFixtures(client);
    console.log(`\nDeleted ${deleted} fixture product(s).`);
    return;
  }

  console.log(`Seeding fixtures on ${shop}...`);
  console.log(`Removing any existing fixtures tagged "${FIXTURE_TAG}" first (idempotent reseed)...`);
  const deleted = await cleanFixtures(client);
  console.log(`Removed ${deleted} pre-existing fixture product(s).\n`);

  const created: { title: string; id: string; triggers: string }[] = [];
  for (const fixture of FIXTURES) {
    created.push(await createFixtureProduct(client, fixture));
  }

  printSummary(created);
}

main().catch((err: unknown) => {
  console.error("\nseed-fixtures failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
