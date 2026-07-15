import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import { Page, Card, Text, Button, BlockStack, List, Link } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ActiveScanError } from "../services/scan/queue.server";
import { startScan, getActiveScanForShop } from "../services/scan/scan-api.server";

const DEFAULT_VARIANT_LIMIT = 5000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [activeScan, shop] = await Promise.all([
    getActiveScanForShop(session.shop),
    prisma.shop.findUnique({
      where: { shopDomain: session.shop },
      include: { settings: true },
    }),
  ]);

  return {
    activeScanId: activeScan?.id ?? null,
    variantLimit: shop?.settings?.catalogVariantLimit ?? DEFAULT_VARIANT_LIMIT,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const scan = await startScan(session.shop);
    return redirect(`/app/scans/${scan.id}`);
  } catch (error) {
    if (error instanceof ActiveScanError) {
      const active = await getActiveScanForShop(session.shop);
      if (active) {
        return redirect(`/app/scans/${active.id}`);
      }
    }
    throw error;
  }
};

export default function Index() {
  const { activeScanId, variantLimit } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state !== "idle" && navigation.formMethod === "POST";

  return (
    <Page>
      <TitleBar title="Catalog Audit" />
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="400">
            <BlockStack gap="200">
              <Text as="h2" variant="headingLg">
                Check your catalog for pricing and identifier mistakes.
              </Text>
              <Text as="p" variant="bodyMd">
                MerchGrid reads your product and variant data but never
                changes your store.
              </Text>
            </BlockStack>

            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                What we check
              </Text>
              <List type="bullet">
                <List.Item>Below-cost prices</List.Item>
                <List.Item>Invalid compare-at/sale prices</List.Item>
                <List.Item>Duplicate or missing SKUs</List.Item>
                <List.Item>Duplicate barcodes</List.Item>
                <List.Item>Missing costs</List.Item>
                <List.Item>Suspicious variant prices</List.Item>
              </List>
            </BlockStack>

            <Form method="post">
              <BlockStack gap="200">
                <Button
                  submit
                  variant="primary"
                  loading={isSubmitting}
                  disabled={isSubmitting}
                >
                  Run catalog audit
                </Button>
                <Text as="p" variant="bodySm" tone="subdued">
                  This scan reviews up to {variantLimit} variants.{" "}
                  <Link url="#">Privacy policy</Link>
                </Text>
              </BlockStack>
            </Form>

            {activeScanId && (
              <Button url={`/app/scans/${activeScanId}`} variant="secondary">
                View current scan
              </Button>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
