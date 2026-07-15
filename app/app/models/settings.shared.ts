/**
 * Constants shared between the settings service (server-only) and the
 * settings route's UI component (client + server). Kept in a non-`.server`
 * module so referencing it from the React component doesn't pull
 * `settings.server.ts` (and its Prisma import) into the client bundle.
 */
export const MARGIN_MIN = 0;
export const MARGIN_MAX = 90;
