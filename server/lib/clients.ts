// Workspace-client helpers for Unity Catalog discovery.
//
// AppKit's workspace-client facade does not expose catalogs/schemas/tables, so
// we drop to the bundled legacy @databricks/sdk-experimental client via
// toLegacyWorkspaceClient(). Discovery runs on-behalf-of the requesting user
// when Databricks Apps injects the x-forwarded-access-token header (so UC
// grants are enforced), and falls back to the app service principal locally.

import type { Request } from 'express';
import { createWorkspaceClient } from '@databricks/appkit';
import type { WorkspaceClient as LegacyWorkspaceClient } from '@databricks/sdk-experimental';

/** Full legacy SDK client as the app service principal (default auth chain). */
export function spLegacyClient(): LegacyWorkspaceClient {
  return createWorkspaceClient().toLegacyWorkspaceClient();
}

/**
 * Full legacy SDK client as the end user, from Databricks Apps headers.
 * Falls back to the service principal when no forwarded token is present
 * (e.g. local `npm run dev` without OBO headers).
 */
export function ucClient(req: Request): LegacyWorkspaceClient {
  const token = req.header('x-forwarded-access-token');
  if (!token) return spLegacyClient();
  const host = process.env.DATABRICKS_HOST;
  return createWorkspaceClient({ host, token, authType: 'pat' }).toLegacyWorkspaceClient();
}
