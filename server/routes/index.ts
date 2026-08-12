// Registers all custom API routes on the Express app.

import type { Application } from 'express';
import type { AppKit } from '../lib/appkit.js';
import { registerDiscoveryRoutes } from './discovery.js';
import { registerReportRoutes } from './reports.js';
import { registerScheduleRoutes } from './schedules.js';

export function registerRoutes(app: Application, appkit: AppKit): void {
  registerDiscoveryRoutes(app, appkit);
  registerReportRoutes(app, appkit);
  registerScheduleRoutes(app, appkit);
}
