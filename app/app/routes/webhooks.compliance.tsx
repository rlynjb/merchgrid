import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { redactShop } from "../models/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, payload);

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
