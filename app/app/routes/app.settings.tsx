import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { Banner, BlockStack, Button, Card, Page, Text, TextField } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState } from "react";

import { authenticate } from "../shopify.server";
import {
  InvalidMarginError,
  getMinimumMargin,
  updateMinimumMargin,
} from "../models/settings.server";
import { MARGIN_MAX, MARGIN_MIN } from "../models/settings.shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const minimumMarginPercent = await getMinimumMargin(session.shop);

  return json({ minimumMarginPercent });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const raw = formData.get("minimumMarginPercent");
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const value = Number(trimmed);

  if (trimmed === "" || Number.isNaN(value)) {
    return json(
      {
        ok: false as const,
        error: `Enter a whole number between ${MARGIN_MIN} and ${MARGIN_MAX}`,
      },
      { status: 400 },
    );
  }

  try {
    const saved = await updateMinimumMargin(session.shop, value);
    return json({ ok: true as const, minimumMarginPercent: saved });
  } catch (error) {
    if (error instanceof InvalidMarginError) {
      return json({ ok: false as const, error: error.message }, { status: 400 });
    }
    throw error;
  }
};

export default function Settings() {
  const { minimumMarginPercent } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state !== "idle" && navigation.formMethod === "POST";

  const [value, setValue] = useState(String(minimumMarginPercent));

  const errorMessage = actionData && !actionData.ok ? actionData.error : undefined;
  const showSuccess = actionData?.ok === true && !isSubmitting;

  return (
    <Page>
      <TitleBar title="Settings" />
      <BlockStack gap="500">
        <Card>
          <Form method="post">
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Minimum gross margin
              </Text>

              {showSuccess && (
                <Banner tone="success">Settings saved.</Banner>
              )}
              {errorMessage && (
                <Banner tone="critical">{errorMessage}</Banner>
              )}

              <TextField
                label="Minimum gross margin %"
                name="minimumMarginPercent"
                type="number"
                min={MARGIN_MIN}
                max={MARGIN_MAX}
                suffix="%"
                autoComplete="off"
                value={value}
                onChange={setValue}
                error={errorMessage}
                helpText="This is an adjustable screening threshold used to flag variants below your minimum gross margin. It is not business advice. Changing it does not affect past scans — each scan records the threshold it used."
              />

              <Button submit variant="primary" loading={isSubmitting}>
                Save
              </Button>
            </BlockStack>
          </Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
