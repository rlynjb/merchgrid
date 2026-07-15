import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { redactShop } from "../models/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  // Do NOT log the payload: customers/data_request and customers/redact
  // payloads contain customer PII (id, email, phone). Log topic + shop only.
  console.log(`Received compliance webhook ${topic} for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // MerchGrid stores no customer data; nothing to return.
      return new Response();

    case "CUSTOMERS_REDACT":
      // MerchGrid stores no customer data; nothing to delete.
      return new Response();

    case "SHOP_REDACT":
      // Fired ~48h after uninstall. Delete all data for the shop.
      await redactShop(shop);
      return new Response();

    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }
};
