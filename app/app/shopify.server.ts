import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { ensureShop } from "./models/shop.server";
import { EncryptedSessionStorage } from "./services/session/encrypted-session-storage.server";

// Encrypt access/refresh tokens at rest whenever a key is configured
// (production). Local dev / tests without SESSION_ENCRYPTION_KEY keep
// using the plain PrismaSessionStorage. Pre-existing plaintext sessions
// (from before this was enabled) still load fine — decryptToken passes
// unmarked values through unchanged — and get encrypted on next write.
const prismaSessionStorage = new PrismaSessionStorage(prisma);
const configuredSessionStorage = process.env.SESSION_ENCRYPTION_KEY
  ? new EncryptedSessionStorage(
      prismaSessionStorage,
      process.env.SESSION_ENCRYPTION_KEY,
    )
  : prismaSessionStorage;

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: configuredSessionStorage,
  distribution: AppDistribution.AppStore,
  hooks: {
    afterAuth: async ({ session }) => {
      // Provision the Shop/ShopSettings rows immediately after OAuth
      // completes (covers both fresh installs and reinstalls), then
      // register webhooks for the shop as the Shopify template does.
      await ensureShop(session.shop);
      await shopify.registerWebhooks({ session });
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
