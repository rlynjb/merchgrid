import type { LoaderFunctionArgs } from "@remix-run/node";

/**
 * Trivial, unauthenticated health check for Fly.io's HTTP service checks
 * (see `[[http_service.checks]]` in fly.toml). Deliberately has NO Shopify
 * auth and NO Prisma/DB access: it must return 200 as soon as the Remix
 * server is accepting connections, so Fly can tell "the process is up"
 * apart from "the embedded app / database is fully healthy."
 */
export const loader = async (_args: LoaderFunctionArgs) => {
  return new Response("ok", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
};
