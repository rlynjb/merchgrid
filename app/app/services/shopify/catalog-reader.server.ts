import type {
  RawCatalog,
  RawInventoryItem,
  RawMoney,
  RawProductNode,
  RawVariantNode,
} from "@merchgrid/catalog-core";

/**
 * The subset of the Shopify Admin GraphQL client we need. Matches the
 * shape of `admin` returned by `authenticate.admin(request)` in
 * `app/shopify.server.ts`, but kept minimal and dependency-free so this
 * module can be unit tested with a fake — no live Shopify calls, no
 * import of the Shopify SDK here.
 */
export interface AdminGraphqlClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<any> }>;
}

export interface ReadCatalogOptions {
  /** Stop once this many variants have been processed (spec guardrail). */
  variantLimit: number;
}

// Read-only: this module must never issue a mutation. Only `query`
// operations below.
const PRODUCTS_PAGE_QUERY = `#graphql
  query CatalogReaderProducts($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        status
        handle
        variants(first: 100) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            price
            compareAtPrice
            sku
            barcode
            inventoryPolicy
            inventoryQuantity
            inventoryItem {
              tracked
              unitCost {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  }
`;

// Sub-pagination for products with more than 100 variants (rare in the
// standard Shopify product model, which caps variants at 100). We paginate
// to completion (option (a) from the task spec) rather than truncating,
// since the shape of this follow-up query mirrors the variants field
// above and adds no real complexity.
const PRODUCT_VARIANTS_PAGE_QUERY = `#graphql
  query CatalogReaderProductVariants($id: ID!, $cursor: String) {
    product(id: $id) {
      variants(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          price
          compareAtPrice
          sku
          barcode
          inventoryPolicy
          inventoryQuantity
          inventoryItem {
            tracked
            unitCost {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

interface GraphqlPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GraphqlVariantNode {
  id: string;
  title: string;
  price: string;
  compareAtPrice: string | null;
  sku: string | null;
  barcode: string | null;
  inventoryPolicy?: string | null;
  inventoryQuantity?: number | null;
  inventoryItem: {
    tracked: boolean;
    unitCost: RawMoney | null;
  } | null;
}

interface GraphqlProductNode {
  id: string;
  title: string;
  status: string;
  handle: string;
  variants: {
    pageInfo?: GraphqlPageInfo;
    nodes: GraphqlVariantNode[];
  };
}

async function runQuery(
  admin: AdminGraphqlClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<any> {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();

  if (body?.errors && Array.isArray(body.errors) && body.errors.length > 0) {
    // Don't leak internal GraphQL error details (query text, schema
    // internals, etc.) to callers/logs beyond this safe message.
    throw new Error(
      "Failed to read catalog from Shopify: the GraphQL request returned errors.",
    );
  }

  return body;
}

function mapInventoryItem(
  item: GraphqlVariantNode["inventoryItem"],
): RawInventoryItem | null {
  if (!item) return null;
  return {
    tracked: item.tracked,
    unitCost: item.unitCost
      ? { amount: item.unitCost.amount, currencyCode: item.unitCost.currencyCode }
      : null,
  };
}

function mapVariant(node: GraphqlVariantNode): RawVariantNode {
  const mapped: RawVariantNode = {
    id: node.id,
    title: node.title,
    price: node.price,
    compareAtPrice: node.compareAtPrice ?? null,
    sku: node.sku ?? null,
    barcode: node.barcode ?? null,
    inventoryItem: mapInventoryItem(node.inventoryItem),
  };

  if (node.inventoryPolicy !== undefined) {
    mapped.inventoryPolicy = node.inventoryPolicy;
  }
  if (node.inventoryQuantity !== undefined) {
    mapped.inventoryQuantity = node.inventoryQuantity;
  }

  return mapped;
}

/**
 * Fetches the full set of variants for a single product, following the
 * variants connection's own cursor if the first page reported
 * `hasNextPage: true` (a product with more than 100 variants).
 */
async function fetchAllVariants(
  admin: AdminGraphqlClient,
  productId: string,
  firstPageNodes: GraphqlVariantNode[],
  firstPageInfo: GraphqlPageInfo | undefined,
): Promise<GraphqlVariantNode[]> {
  const nodes = [...firstPageNodes];
  let pageInfo = firstPageInfo;

  while (pageInfo?.hasNextPage) {
    const body = await runQuery(admin, PRODUCT_VARIANTS_PAGE_QUERY, {
      id: productId,
      cursor: pageInfo.endCursor,
    });
    const connection = body.data.product.variants;
    nodes.push(...connection.nodes);
    pageInfo = connection.pageInfo;
  }

  return nodes;
}

async function buildProduct(
  admin: AdminGraphqlClient,
  node: GraphqlProductNode,
): Promise<RawProductNode> {
  const variantNodes = await fetchAllVariants(
    admin,
    node.id,
    node.variants.nodes,
    node.variants.pageInfo,
  );

  return {
    id: node.id,
    title: node.title,
    status: node.status,
    handle: node.handle,
    variants: { nodes: variantNodes.map(mapVariant) },
  };
}

/**
 * Reads the shop's product catalog via the Shopify Admin GraphQL API,
 * paginating products (and, if needed, a product's variants) until either
 * the catalog is exhausted or `opts.variantLimit` is reached.
 *
 * Read-only by construction: every request issued here is a GraphQL
 * `query`, never a `mutation`.
 *
 * Rate-limit/throttle retry handling is explicitly out of scope for this
 * function — a follow-up concern, not implemented here.
 */
export async function readCatalog(
  admin: AdminGraphqlClient,
  opts: ReadCatalogOptions,
): Promise<RawCatalog> {
  const products: RawProductNode[] = [];
  let productsProcessed = 0;
  let variantsProcessed = 0;
  let cursor: string | undefined;

  for (;;) {
    const body = await runQuery(admin, PRODUCTS_PAGE_QUERY, { cursor });
    const connection = body.data.products;
    const pageNodes: GraphqlProductNode[] = connection.nodes;
    const pageInfo: GraphqlPageInfo = connection.pageInfo;

    for (let i = 0; i < pageNodes.length; i++) {
      const product = await buildProduct(admin, pageNodes[i]);
      products.push(product);
      productsProcessed += 1;
      variantsProcessed += product.variants.nodes.length;

      if (variantsProcessed >= opts.variantLimit) {
        const moreProductsInThisPage = i < pageNodes.length - 1;
        return {
          products,
          productsProcessed,
          variantsProcessed,
          partial: moreProductsInThisPage || pageInfo.hasNextPage,
        };
      }
    }

    if (!pageInfo.hasNextPage) {
      return { products, productsProcessed, variantsProcessed, partial: false };
    }
    cursor = pageInfo.endCursor ?? undefined;
  }
}
