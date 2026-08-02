import { useEffect, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import {
  Form,
  isRouteErrorResponse,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useRouteError,
  useSearchParams,
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
  Modal,
  Page,
  Pagination,
  Select,
  Spinner,
  Text,
  TextField,
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

  const severity = url.searchParams.get("severity") || "";
  const checkId = url.searchParams.get("checkId") || "";
  const q = url.searchParams.get("q") || "";

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
  const checkDescriptions: Record<string, string> = Object.fromEntries(
    ALL_CHECKS.map((check) => [check.id, check.description]),
  );
  const checks = ALL_CHECKS.map((check) => ({
    id: check.id,
    name: check.name,
  }));

  const findingsPage =
    summary.status === "COMPLETED"
      ? await getScanFindings(session.shop, scanId, {
          page,
          pageSize: PAGE_SIZE,
          severity: severity || undefined,
          checkId: checkId || undefined,
          search: q || undefined,
        })
      : null;

  return {
    summary,
    checkNames,
    checkDescriptions,
    checks,
    findingsPage,
    filters: { severity, checkId, q },
  };
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

const SEVERITY_OPTIONS = [
  { label: "All severities", value: "" },
  { label: "Critical", value: "CRITICAL" },
  { label: "Warning", value: "WARNING" },
  { label: "Unavailable", value: "UNAVAILABLE" },
];

function FilterBar({
  scanId,
  checks,
  filters,
}: {
  scanId: string;
  checks: { id: string; name: string }[];
  filters: { severity: string; checkId: string; q: string };
}) {
  const [severity, setSeverity] = useState(filters.severity);
  const [checkId, setCheckId] = useState(filters.checkId);
  const [q, setQ] = useState(filters.q);

  useEffect(() => {
    setSeverity(filters.severity);
    setCheckId(filters.checkId);
    setQ(filters.q);
  }, [filters.severity, filters.checkId, filters.q]);

  const checkOptions = [
    { label: "All checks", value: "" },
    ...checks.map((check) => ({ label: check.name, value: check.id })),
  ];

  return (
    <Card>
      <Form method="get">
        <InlineStack gap="400" blockAlign="end" wrap>
          <Select
            label="Severity"
            name="severity"
            options={SEVERITY_OPTIONS}
            value={severity}
            onChange={setSeverity}
          />
          <Select
            label="Check"
            name="checkId"
            options={checkOptions}
            value={checkId}
            onChange={setCheckId}
          />
          <Box minWidth="16rem">
            <TextField
              label="Search"
              name="q"
              autoComplete="off"
              value={q}
              onChange={setQ}
              placeholder="Product, variant, SKU, or barcode"
            />
          </Box>
          <Button submit variant="primary">
            Apply filters
          </Button>
          <Link url={`/app/scans/${scanId}`}>Clear filters</Link>
        </InlineStack>
      </Form>
    </Card>
  );
}

function FindingDetailModal({
  finding,
  checkNames,
  checkDescriptions,
  onClose,
}: {
  finding: FindingRow | null;
  checkNames: Record<string, string>;
  checkDescriptions: Record<string, string>;
  onClose: () => void;
}) {
  if (!finding) return null;

  const badge = SEVERITY_BADGE[finding.severity] ?? {
    label: finding.severity,
    tone: "info" as const,
  };
  const currency = finding.currency ?? "";

  return (
    <Modal
      open={finding !== null}
      onClose={onClose}
      title={checkNames[finding.checkId] ?? finding.checkId}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <InlineStack gap="200" blockAlign="center">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {finding.productTitle}
              {finding.variantTitle ? ` — ${finding.variantTitle}` : ""}
            </Text>
          </InlineStack>

          {finding.productStatus && (
            <Text as="p" variant="bodySm" tone="subdued">
              Product status: {finding.productStatus}
            </Text>
          )}

          <Text as="p" variant="bodyMd">
            {checkDescriptions[finding.checkId] ?? ""}
          </Text>

          <Text as="p" variant="bodyMd">
            {finding.explanation}
          </Text>

          {finding.severity === "WARNING" && (
            <Banner tone="warning">
              This may be an intentional configuration — review before
              changing anything.
            </Banner>
          )}

          <BlockStack gap="100">
            <Text as="h3" variant="headingSm">
              Pricing
            </Text>
            <Text as="p" variant="bodyMd">
              Current price:{" "}
              {finding.price !== null ? `${currency} ${finding.price}` : "—"}
            </Text>
            <Text as="p" variant="bodyMd">
              Compare-at price:{" "}
              {finding.compareAtPrice !== null
                ? `${currency} ${finding.compareAtPrice}`
                : "—"}
            </Text>
            <Text as="p" variant="bodyMd">
              Unit cost:{" "}
              {finding.unitCost !== null
                ? `${currency} ${finding.unitCost}`
                : "—"}
            </Text>
            <Text as="p" variant="bodyMd">
              Gross margin estimate:{" "}
              {finding.marginAmount !== null && finding.marginPercent !== null
                ? `${currency} ${finding.marginAmount} (${finding.marginPercent.toFixed(1)}%)`
                : "Not available — unit cost missing"}
            </Text>
          </BlockStack>

          <BlockStack gap="100">
            <Text as="h3" variant="headingSm">
              Identifiers
            </Text>
            <Text as="p" variant="bodyMd">
              SKU: {finding.sku ?? "—"}
            </Text>
            <Text as="p" variant="bodyMd">
              Barcode: {finding.barcode ?? "—"}
            </Text>
          </BlockStack>

          <Box>
            <Button url={finding.adminUrl} external>
              Open in Shopify
            </Button>
          </Box>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function FindingsTable({
  findingsPage,
  checkNames,
  onSelectFinding,
}: {
  findingsPage: { findings: FindingRow[]; total: number; page: number; pageSize: number };
  checkNames: Record<string, string>;
  onSelectFinding: (finding: FindingRow) => void;
}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { findings, total, page, pageSize } = findingsPage;

  const buildPageUrl = (targetPage: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(targetPage));
    return `?${params.toString()}`;
  };

  const rowMarkup = findings.map((row, index) => {
    const badge = SEVERITY_BADGE[row.severity] ?? {
      label: row.severity,
      tone: "info" as const,
    };
    const dataFields = findingDataFields(row);

    return (
      <IndexTable.Row
        id={row.id}
        key={row.id}
        position={index}
        onClick={() => onSelectFinding(row)}
      >
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
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- stops the row's own onClick from double-firing when an inner action is used */}
          <span onClick={(event) => event.stopPropagation()}>
            <InlineStack gap="300">
              <Link url={row.adminUrl} target="_blank" removeUnderline>
                Open in Shopify
              </Link>
              <Button variant="plain" onClick={() => onSelectFinding(row)}>
                Details
              </Button>
            </InlineStack>
          </span>
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
            onNext={() => navigate(buildPageUrl(page + 1))}
            onPrevious={() => navigate(buildPageUrl(page - 1))}
          />
        </InlineStack>
      </Box>
    </Card>
  );
}

export default function ScanDetail() {
  const { summary, checkNames, checkDescriptions, checks, findingsPage, filters } =
    useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [selectedFinding, setSelectedFinding] = useState<FindingRow | null>(
    null,
  );
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState(false);

  async function handleExportCsv(scanId: string) {
    // Deliberately a plain in-page fetch (not window.open/a navigation):
    // firing from inside the embedded iframe lets App Bridge's patched
    // fetch attach the session token automatically, and a raw fetch call
    // is never something Remix's router can intercept as an internal
    // route transition (unlike a Button url/Link, which it does — see
    // the CSV-export bug this replaced).
    setExportError(false);
    setExportPending(true);
    try {
      const response = await fetch(`/api/scans/${scanId}/export`);
      if (!response.ok) {
        throw new Error(`Export failed with status ${response.status}`);
      }
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] ?? `merchgrid-catalog-audit-findings-${scanId}.csv`;

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error("CSV export failed", error);
      setExportError(true);
    } finally {
      setExportPending(false);
    }
  }

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

        {exportError && (
          <Banner tone="critical" onDismiss={() => setExportError(false)}>
            The CSV export failed. Please try again.
          </Banner>
        )}

        <InlineStack align="end">
          <Button
            onClick={() => handleExportCsv(summary.id)}
            loading={exportPending}
          >
            Export CSV
          </Button>
        </InlineStack>

        {findingsPage && (
          <FilterBar scanId={summary.id} checks={checks} filters={filters} />
        )}

        {findingsPage && (
          <FindingsTable
            findingsPage={findingsPage}
            checkNames={checkNames}
            onSelectFinding={setSelectedFinding}
          />
        )}

        <FindingDetailModal
          finding={selectedFinding}
          checkNames={checkNames}
          checkDescriptions={checkDescriptions}
          onClose={() => setSelectedFinding(null)}
        />
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
