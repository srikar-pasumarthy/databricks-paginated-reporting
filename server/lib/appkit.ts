// Minimal structural type for the AppKit handle passed to onPluginsReady.
// We type only the plugin surfaces this app uses, so route modules can share
// one import without depending on AppKit's full generic PluginMap inference.

import type { Application } from 'express';

export interface LakebaseResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount?: number;
}

export interface AnalyticsResult {
  // executeStatement().result — AppKit maps rows to named objects on `.data`.
  data?: Record<string, unknown>[];
  row_count?: number;
  chunk_index?: number;
  row_offset?: number;
}

export interface AnalyticsApi {
  // We only issue generated, identifier-validated SELECTs (no bound params),
  // so the parameter map is intentionally omitted here.
  //
  // NOTE: We call this directly (service-principal execution). AppKit v0.56.0's
  // `analytics.asUser(req).query()` OBO path is broken — its exports() returns an
  // unbound `this.query`, so `this` is lost and `this.queryProcessor` throws.
  // Build-time is still user-gated via OBO UC calls (see clients.ts), so users
  // can only build structures on tables they can access; the data query then
  // runs as the app service principal (which holds CAN_USE on the warehouse).
  query(query: string): Promise<AnalyticsResult>;
}

export interface AppKit {
  lakebase: {
    query<T = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<LakebaseResult<T>>;
  };
  analytics: AnalyticsApi;
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

/**
 * Narrow AppKit's generic PluginMap to the structural `AppKit` handle this app
 * uses. The runtime object already exposes these members (server/lakebase/
 * analytics); we assert the shape once here so route code stays typed.
 */
export function toHandle(appkit: object): AppKit {
  return appkit as AppKit;
}
