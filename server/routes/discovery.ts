// Unity Catalog discovery routes. Uses the legacy SDK UC list/get APIs
// (no warehouse needed) on-behalf-of the requesting user so grants apply.

import type { Application } from 'express';
import type { AppKit } from '../lib/appkit.js';
import { asyncHandler, queryStr } from '../lib/http.js';
import { ucClient } from '../lib/clients.js';
import { fieldFromType } from '../lib/type-parser.js';
import { HttpError } from '../lib/access.js';

export function registerDiscoveryRoutes(app: Application, _appkit: AppKit): void {
  // List catalogs.
  app.get(
    '/api/uc/catalogs',
    asyncHandler(async (req, res) => {
      const ws = ucClient(req);
      const out: { name: string; comment?: string }[] = [];
      for await (const c of ws.catalogs.list({})) {
        if (c.name) out.push({ name: c.name, comment: c.comment });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      res.json(out);
    }),
  );

  // List schemas in a catalog.
  app.get(
    '/api/uc/schemas',
    asyncHandler(async (req, res) => {
      const catalog = queryStr(req, 'catalog');
      if (!catalog) throw new HttpError(400, 'catalog is required');
      const ws = ucClient(req);
      const out: { name: string; comment?: string }[] = [];
      for await (const s of ws.schemas.list({ catalog_name: catalog })) {
        if (s.name) out.push({ name: s.name, comment: s.comment });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      res.json(out);
    }),
  );

  // List tables in a schema.
  app.get(
    '/api/uc/tables',
    asyncHandler(async (req, res) => {
      const catalog = queryStr(req, 'catalog');
      const schema = queryStr(req, 'schema');
      if (!catalog || !schema) throw new HttpError(400, 'catalog and schema are required');
      const ws = ucClient(req);
      const out: { name: string; full_name: string; table_type?: string; comment?: string }[] = [];
      for await (const t of ws.tables.list({
        catalog_name: catalog,
        schema_name: schema,
        omit_columns: true,
      })) {
        if (t.name && t.full_name) {
          out.push({
            name: t.name,
            full_name: t.full_name,
            table_type: t.table_type,
            comment: t.comment,
          });
        }
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      res.json(out);
    }),
  );

  // Get a table's columns, with parsed nested field trees.
  app.get(
    '/api/uc/columns',
    asyncHandler(async (req, res) => {
      const fullName = queryStr(req, 'full_name');
      if (!fullName) throw new HttpError(400, 'full_name is required');
      const ws = ucClient(req);
      const table = await ws.tables.get({ full_name: fullName });
      const columns = (table.columns ?? []).map((c) => ({
        name: c.name ?? '',
        type_text: c.type_text ?? c.type_name ?? 'string',
        comment: c.comment,
        field: fieldFromType(c.name ?? '', c.type_text ?? c.type_name ?? 'string'),
      }));
      res.json({ full_name: fullName, columns });
    }),
  );
}
