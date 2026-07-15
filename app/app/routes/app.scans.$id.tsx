import { useEffect } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import {
  isRouteErrorResponse,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineGrid,
  InlineStack,
  Link,
  Page,
  Pagination,
  Spinner,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { ALL_CHECKS } from "@merchgrid/catalog-checks";
import { authenticate } from "../shopify.server";
import {
  ScanNotFoundError,
  getScanFindings,
  getScanSummary,
  type FindingRow,
} from "../services/scan/scan-api.server";

const PAGE_SIZE = 50;

const STAGE_STATUSES = [
  "QUEUED",
  "READING_CATALOG",
  "RUNNING_CHECKS",
  "PREPARING_RESULTS",
] as const;

const STAGE_LABELS = [
  "Connecting to Shopify",
  "Reading products and variants",
  "Checking prices, costs, SKUs, and barcodes",
  "Preparing your report",
];

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED"]);

const SEVERITY_BADGE: Record<
  string,
  { label: string; tone: "critical" | "warning" | "info" }
> = {
  CRITICAL: { label: "Critical", tone: "critical" },
  WARNING: { label: "Warning", tone: "warning" },
  UNAVAILABLE: { label: "Unavailable", tone: "info" },
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const scanId = params.id!;

  const url = new URL(request.url);
  const pageParam = Number(url.searchParams.get("page") ?? "1");
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

  let summary;
  try {
    summary = await getScanSummary(session.shop, scanId);
  } catch (error) {
    if (error instanceof ScanNotFoundError) {
      throw new Response("Not found", { status: 404 });
    }
    throw error;
  }

  const checkNames: Record<string, string> = Object.fromEntries(
    ALL_CHECKS.map((check) => [check.id, check.name]),
  );

  const findingsPage =
    summary.status === "COMPLETED"
      ? await getScanFindings(session.shop, scanId, { page, pageSize: PAGE_SIZE })
      : null;

  return { summary, checkNames, findingsPage };
};

function ScanProgressCard({ status }: { status: string }) {
  const currentIndex = STAGE_STATUSES.indexOf(
    status as (typeof STAGE_STATUSES)[number],
  );

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingLg">
          Scanning your catalog
        </Text>
        <BlockStack gap="300">
          {STAGE_LABELS.map((label, index) => {
            const isDone = currentIndex > index;
            const isCurrent = index === currentIndex;
            return (
              <InlineStack key={label} gap="200" blockAlign="center">
                <Box minWidth="1.5rem">
                  {isCurrent ? (
                    <Spinner size="small" accessibilityLabel={`${label} in progress`} />
                  ) : isDone ? (
                    <Text as="span" variant="bodyMd">
                      &#10003;
                    </Text>
                  ) : (
                    <Text as="span" variant="bodyMd" tone="subdued">
                      &#9675;
                    </Text>
                  )}
                </Box>
                <Text
                  as="span"
                  variant="bodyMd"
                  tone={isCurrent ? undefined : isDone ? undefined : "subdued"}
                  fontWeight={isCurrent ? "semibold" : undefined}
                >
                  {label}
                </Text>
              </InlineStack>
            );
          })}
        </BlockStack>
        <Text as="p" variant="bodySm" tone="subdued">
          This page updates automatically — no need to refresh.
        </Text>
      </BlockStack>
    </Card>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="headingXl">
          {value}
        </Text>
        <Text as="p" variant="bodyMd" tone="subdued">
          {label}
        </Text>
      </BlockStack>
    </Card>
  );
}

function findingDataFields(row: FindingRow): string[] {
  const fields: string[] = [];
  if (row.price !== null) {
    fields.push(`${row.currency ?? ""} ${row.price}`.trim());
  }
  if (row.unitCost !== null) {
    fields.push(`Cost: ${row.currency ?? ""} ${row.unitCost}`.trim());
  }
  if (row.compareAtPrice !== null) {
    fields.push(`Compare-at: ${row.currency ?? ""} ${row.compareAtPrice}`.trim());
  }
  if (row.sku !== null) {
    fields.push(`SKU ${row.sku}`);
  }
  if (row.barcode !== null) {
    fields.push(`Barcode ${row.barcode}`);
  }
  return fields;
}

function FindingsTable({
  findingsPage,
  checkNames,
}: {
  findingsPage: { findings: FindingRow[]; total: number; page: number; pageSize: number };
  checkNames: Record<string, string>;
}) {
  const navigate = useNavigate();
  const { findings, total, page, pageSize } = findingsPage;

  const rowMarkup = findings.map((row, index) => {
    const badge = SEVERITY_BADGE[row.severity] ?? {
      label: row.severity,
      tone: "info" as const,
    };
    const dataFields = findingDataFields(row);

    return (
      <IndexTable.Row id={row.id} key={row.id} position={index}>
        <IndexTable.Cell>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {checkNames[row.checkId] ?? row.checkId}
        </IndexTable.Cell>
        <IndexTable.Cell>
          {row.productTitle}
          {row.variantTitle ? ` — ${row.variantTitle}` : ""}
        </IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="050">
            {dataFields.length === 0 ? (
              <Text as="span" variant="bodySm" tone="subdued">
                —
              </Text>
            ) : (
              dataFields.map((field) => (
                <Text as="span" variant="bodySm" key={field}>
                  {field}
                </Text>
              ))
            )}
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>{row.explanation}</IndexTable.Cell>
        <IndexTable.Cell>
          <Link url={row.adminUrl} target="_blank" removeUnderline>
            Open in Shopify
          </Link>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  const hasNext = page * pageSize < total;
  const hasPrevious = page > 1;

  return (
    <Card padding="0">
      <Box padding="400" paddingBlockEnd="200">
        <Text as="p" variant="bodySm" tone="subdued">
          Warnings may reflect intentional configurations — review before
          changing anything.
        </Text>
      </Box>
      <IndexTable
        resourceName={{ singular: "finding", plural: "findings" }}
        itemCount={findings.length}
        selectable={false}
        headings={[
          { title: "Severity" },
          { title: "Check" },
          { title: "Product / variant" },
          { title: "Current data" },
          { title: "Explanation" },
          { title: "Action" },
        ]}
      >
        {rowMarkup}
      </IndexTable>
      <Box padding="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="bodySm" tone="subdued">
            {total} findings
          </Text>
          <Pagination
            hasNext={hasNext}
            hasPrevious={hasPrevious}
            onNext={() => navigate(`?page=${page + 1}`)}
            onPrevious={() => navigate(`?page=${page - 1}`)}
          />
        </InlineStack>
      </Box>
    </Card>
  );
}

export default function ScanDetail() {
  const { summary, checkNames, findingsPage } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  const isTerminal = TERMINAL_STATUSES.has(summary.status);

  useEffect(() => {
    if (isTerminal) return;
    const interval = setInterval(() => {
      revalidator.revalidate();
    }, 2500);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTerminal, summary.status]);

  if (!isTerminal) {
    return (
      <Page>
        <TitleBar title="Catalog Audit" />
        <BlockStack gap="500">
          <ScanProgressCard status={summary.status} />
        </BlockStack>
      </Page>
    );
  }

  if (summary.status === "FAILED") {
    return (
      <Page>
        <TitleBar title="Catalog Audit" />
        <BlockStack gap="500">
          <Banner tone="critical">
            <BlockStack gap="200">
              <Text as="p">
                {summary.failureMessageSafe ??
                  "The scan could not be completed."}
              </Text>
              <Box>
                <Button url="/app">Back to start</Button>
              </Box>
            </BlockStack>
          </Banner>
        </BlockStack>
      </Page>
    );
  }

  // COMPLETED
  return (
    <Page>
      <TitleBar title="Catalog Audit" />
      <BlockStack gap="500">
        {summary.partial && (
          <Banner tone="warning">
            This scan was partial — only the first {summary.variantsProcessed}{" "}
            variants were reviewed.
          </Banner>
        )}

        <InlineGrid columns={{ xs: 1, sm: 4 }} gap="400">
          <SummaryCard label="Critical issues" value={summary.critical} />
          <SummaryCard label="Warnings" value={summary.warning} />
          <SummaryCard label="Could not evaluate" value={summary.unavailable} />
          <SummaryCard
            label="Variants checked"
            value={summary.variantsProcessed}
          />
        </InlineGrid>

        {summary.critical > 0 && (
          <Banner tone="critical">
            {summary.critical} findings need urgent review — including
            below-cost prices. Review these first.
          </Banner>
        )}

        <InlineStack align="end">
          <Button url={`/api/scans/${summary.id}/export`} external>
            Export CSV
          </Button>
        </InlineStack>

        {findingsPage && (
          <FindingsTable findingsPage={findingsPage} checkNames={checkNames} />
        )}
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <Page>
        <TitleBar title="Catalog Audit" />
        <BlockStack gap="500">
          <Banner tone="critical">
            <BlockStack gap="200">
              <Text as="p">
                Scan not found. It may have been removed, or it belongs to a
                different store.
              </Text>
              <Box>
                <Button url="/app">Back to start</Button>
              </Box>
            </BlockStack>
          </Banner>
        </BlockStack>
      </Page>
    );
  }

  throw error;
}
