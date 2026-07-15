import { describe, expect, it } from "vitest";
import type {
  AdminGraphqlClient,
  ReadCatalogOptions,
} from "../app/services/shopify/catalog-reader.server";
import { readCatalog } from "../app/services/shopify/catalog-reader.server";

// A canned "page" mimics the raw JSON body the real Shopify Admin GraphQL
// API would return from `res.json()`: `{ data: { products: {...} } }`.
type CannedPage =
  | { data: any }
  | {
      data?: any;
      errors: Array<{ message: string; extensions?: { code?: string } }>;
    };

interface FakeCall {
  query: string;
  variables?: Record<string, unknown>;
}

function createFakeAdmin(pages: CannedPage[]): {
  admin: AdminGraphqlClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let callIndex = 0;

  const admin: AdminGraphqlClient = {
    async graphql(query, options) {
      calls.push({ query, variables: options?.variables });
      const page = pages[callIndex] ?? pages[pages.length - 1];
      callIndex += 1;
      return {
        async json() {
          return page;
        },
      };
    },
  };

  return { admin, calls };
}

function variantFixture(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    title: "Default Title",
    price: "10.00",
    compareAtPrice: null,
    sku: `SKU-${id}`,
    barcode: null,
    inventoryPolicy: "DENY",
    inventoryQuantity: 1,
    inventoryItem: {
      tracked: true,
      unitCost: { amount: "5.00", currencyCode: "USD" },
    },
    ...overrides,
  };
}

// A scripted admin, distinct from `createFakeAdmin`, lets a step reject
// (simulating a network blip / transient 5xx from `admin.graphql` itself)
// instead of only ever resolving with a canned JSON page. Once the script
// is exhausted, the last step repeats (e.g. "always THROTTLED").
type ScriptedStep = { reject: Error } | { page: CannedPage };

function createScriptedAdmin(steps: ScriptedStep[]): {
  admin: AdminGraphqlClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let callIndex = 0;

  const admin: AdminGraphqlClient = {
    async graphql(query, options) {
      calls.push({ query, variables: options?.variables });
      const step = steps[callIndex] ?? steps[steps.length - 1];
      callIndex += 1;
      if ("reject" in step) {
        throw step.reject;
      }
      return {
        async json() {
          return step.page;
        },
      };
    },
  };

  return { admin, calls };
}

const throttledPage: CannedPage = {
  errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
};

function productFixture(id: string, variants: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Product ${id}`,
    status: "ACTIVE",
    handle: `product-${id}`,
    variants: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: variants,
    },
    ...overrides,
  };
}

describe("readCatalog", () => {
  describe("pagination", () => {
    it("follows cursors across multiple product pages", async () => {
      const page1: CannedPage = {
        data: {
          products: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [productFixture("1", [variantFixture("1")])],
          },
        },
      };
      const page2: CannedPage = {
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [productFixture("2", [variantFixture("2")])],
          },
        },
      };

      const { admin, calls } = createFakeAdmin([page1, page2]);
      const opts: ReadCatalogOptions = { variantLimit: 1000 };
      const result = await readCatalog(admin, opts);

      expect(result.products.map((p) => p.id)).toEqual([
        "gid://shopify/Product/1",
        "gid://shopify/Product/2",
      ]);
      expect(result.productsProcessed).toBe(2);
      expect(result.variantsProcessed).toBe(2);
      expect(result.partial).toBe(false);

      expect(calls.length).toBe(2);
      expect(calls[0].variables?.cursor).toBeUndefined();
      expect(calls[1].variables?.cursor).toBe("c1");
    });
  });

  describe("field mapping", () => {
    it("maps variant fields, preserving nulls and decimal strings verbatim", async () => {
      const page: CannedPage = {
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              productFixture("1", [
                variantFixture("1", {
                  price: "12.50",
                  compareAtPrice: null,
                  sku: null,
                  barcode: null,
                  inventoryItem: null,
                }),
                variantFixture("2", {
                  price: "20.00",
                  compareAtPrice: "25.00",
                  sku: "SKU-2",
                  barcode: "0123456789",
                  inventoryItem: { tracked: true, unitCost: null },
                }),
              ]),
            ],
          },
        },
      };

      const { admin } = createFakeAdmin([page]);
      const result = await readCatalog(admin, { variantLimit: 1000 });

      const [v1, v2] = result.products[0].variants.nodes;

      expect(v1.inventoryItem).toBeNull();
      expect(v1.compareAtPrice).toBeNull();
      expect(v1.sku).toBeNull();
      expect(v1.barcode).toBeNull();
      expect(v1.price).toBe("12.50");

      expect(v2.inventoryItem).toEqual({ tracked: true, unitCost: null });
      expect(v2.compareAtPrice).toBe("25.00");
      expect(v2.sku).toBe("SKU-2");
      expect(v2.price).toBe("20.00");
    });

    it("passes through a full inventoryItem with unitCost", async () => {
      const page: CannedPage = {
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              productFixture("1", [
                variantFixture("1", {
                  inventoryItem: {
                    tracked: true,
                    unitCost: { amount: "7.25", currencyCode: "CAD" },
                  },
                }),
              ]),
            ],
          },
        },
      };

      const { admin } = createFakeAdmin([page]);
      const result = await readCatalog(admin, { variantLimit: 1000 });

      expect(result.products[0].variants.nodes[0].inventoryItem).toEqual({
        tracked: true,
        unitCost: { amount: "7.25", currencyCode: "CAD" },
      });
    });
  });

  describe("variant limit + partial", () => {
    it("stops paging and marks partial when the limit is reached mid-page", async () => {
      const page: CannedPage = {
        data: {
          products: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [
              productFixture("1", [variantFixture("1"), variantFixture("2")]),
              productFixture("2", [variantFixture("3")]),
            ],
          },
        },
      };

      const { admin, calls } = createFakeAdmin([page]);
      const result = await readCatalog(admin, { variantLimit: 2 });

      expect(result.variantsProcessed).toBeGreaterThanOrEqual(2);
      expect(result.partial).toBe(true);
      // Only the first page should have been fetched — the reader stops
      // once the limit is reached instead of requesting a second page.
      expect(calls.length).toBe(1);
    });

    it("marks partial false when fully under the limit with no more pages", async () => {
      const page: CannedPage = {
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              productFixture("1", [variantFixture("1")]),
              productFixture("2", [variantFixture("2")]),
            ],
          },
        },
      };

      const { admin } = createFakeAdmin([page]);
      const result = await readCatalog(admin, { variantLimit: 1000 });

      expect(result.variantsProcessed).toBe(2);
      expect(result.partial).toBe(false);
    });

    it("marks partial true when the limit is hit exactly at a page boundary that has more pages", async () => {
      const page1: CannedPage = {
        data: {
          products: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [productFixture("1", [variantFixture("1"), variantFixture("2")])],
          },
        },
      };

      const { admin, calls } = createFakeAdmin([page1]);
      const result = await readCatalog(admin, { variantLimit: 2 });

      expect(result.variantsProcessed).toBe(2);
      expect(result.partial).toBe(true);
      expect(calls.length).toBe(1);
    });
  });

  describe("variant sub-pagination", () => {
    // A canned response for the per-product `variants(after:)` sub-query,
    // shaped like `res.json()` for CatalogReaderProductVariants.
    function variantSubPage(
      variants: unknown[],
      pageInfo: { hasNextPage: boolean; endCursor: string | null },
    ): CannedPage {
      return { data: { product: { variants: { pageInfo, nodes: variants } } } };
    }

    it("follows a product's own variant cursor across pages, collecting in order", async () => {
      const productsPage: CannedPage = {
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              productFixture("1", [variantFixture("1")], {
                variants: {
                  pageInfo: { hasNextPage: true, endCursor: "v1" },
                  nodes: [variantFixture("1")],
                },
              }),
            ],
          },
        },
      };
      const subPage2 = variantSubPage([variantFixture("2")], {
        hasNextPage: false,
        endCursor: null,
      });

      const { admin, calls } = createFakeAdmin([productsPage, subPage2]);
      const result = await readCatalog(admin, { variantLimit: 1000 });

      expect(result.products.length).toBe(1);
      expect(result.products[0].variants.nodes.map((v) => v.id)).toEqual([
        "gid://shopify/ProductVariant/1",
        "gid://shopify/ProductVariant/2",
      ]);
      expect(result.variantsProcessed).toBe(2);
      expect(result.partial).toBe(false);

      // products query, then one variant sub-query carrying the cursor.
      expect(calls.length).toBe(2);
      expect(calls[1].variables?.id).toBe("gid://shopify/Product/1");
      expect(calls[1].variables?.cursor).toBe("v1");
    });

    it("stops sub-paginating one huge product once the catalog variant limit is reached", async () => {
      const productsPage: CannedPage = {
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              productFixture("1", [variantFixture("1")], {
                variants: {
                  pageInfo: { hasNextPage: true, endCursor: "v1" },
                  nodes: [variantFixture("1")],
                },
              }),
            ],
          },
        },
      };
      // Sub-page 1 still reports more pages; the reader must NOT go past it
      // once the budget of 2 variants is met.
      const subPage1 = variantSubPage([variantFixture("2")], {
        hasNextPage: true,
        endCursor: "v2",
      });
      const subPageNeverFetched = variantSubPage([variantFixture("3")], {
        hasNextPage: true,
        endCursor: "v3",
      });

      const { admin, calls } = createFakeAdmin([
        productsPage,
        subPage1,
        subPageNeverFetched,
      ]);
      const result = await readCatalog(admin, { variantLimit: 2 });

      expect(result.variantsProcessed).toBe(2);
      expect(result.partial).toBe(true);
      // products query + exactly one variant sub-query: it stopped instead of
      // draining the whole product (which would have fetched subPageNeverFetched).
      expect(calls.length).toBe(2);
      expect(result.products[0].variants.nodes.map((v) => v.id)).toEqual([
        "gid://shopify/ProductVariant/1",
        "gid://shopify/ProductVariant/2",
      ]);
    });
  });

  describe("errors", () => {
    it("throws a safe error when the GraphQL response contains top-level errors", async () => {
      const page: CannedPage = {
        errors: [{ message: "Some internal Shopify detail that should not leak" }],
      };
      const { admin } = createFakeAdmin([page]);

      await expect(readCatalog(admin, { variantLimit: 1000 })).rejects.toThrow(Error);
    });

    it("throws a safe error when an error-free response is missing products", async () => {
      const page: CannedPage = { data: {} };
      const { admin } = createFakeAdmin([page]);

      await expect(readCatalog(admin, { variantLimit: 1000 })).rejects.toThrow(Error);
    });
  });

  describe("retry", () => {
    const successPage: CannedPage = {
      data: {
        products: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [productFixture("1", [variantFixture("1")])],
        },
      },
    };

    it("retries a THROTTLED response, then succeeds", async () => {
      const { admin, calls } = createScriptedAdmin([
        { page: throttledPage },
        { page: successPage },
      ]);

      const result = await readCatalog(admin, {
        variantLimit: 1000,
        sleep: async () => {},
      });

      expect(result.products.map((p) => p.id)).toEqual([
        "gid://shopify/Product/1",
      ]);
      expect(calls.length).toBe(2);
    });

    it("retries when admin.graphql rejects (transient/network failure), then succeeds", async () => {
      const { admin, calls } = createScriptedAdmin([
        { reject: new Error("ECONNRESET") },
        { page: successPage },
      ]);

      const result = await readCatalog(admin, {
        variantLimit: 1000,
        sleep: async () => {},
      });

      expect(result.products.map((p) => p.id)).toEqual([
        "gid://shopify/Product/1",
      ]);
      expect(calls.length).toBe(2);
    });

    it("throws a safe error after exhausting maxRetries on persistent throttling", async () => {
      const { admin, calls } = createScriptedAdmin([{ page: throttledPage }]);

      await expect(
        readCatalog(admin, {
          variantLimit: 1000,
          sleep: async () => {},
          maxRetries: 2,
        }),
      ).rejects.toThrow(Error);

      // maxRetries + 1 total attempts.
      expect(calls.length).toBe(3);
    });

    it("does not retry a genuine (non-throttle) GraphQL error", async () => {
      const errorPage: CannedPage = {
        errors: [{ message: "Field 'x' doesn't exist on type 'Product'" }],
      };
      const { admin, calls } = createScriptedAdmin([{ page: errorPage }]);

      await expect(
        readCatalog(admin, { variantLimit: 1000, sleep: async () => {} }),
      ).rejects.toThrow(Error);

      expect(calls.length).toBe(1);
    });
  });
});
