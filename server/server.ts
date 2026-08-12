import { createApp, server, analytics, lakebase } from '@databricks/appkit';
import { toHandle } from './lib/appkit.js';
import { initSchema } from './db/schema.js';
import { registerRoutes } from './routes/index.js';

createApp({
  plugins: [server(), analytics(), lakebase()],
  async onPluginsReady(appkit) {
    const handle = toHandle(appkit);
    await initSchema(handle);
    handle.server.extend((app) => registerRoutes(app, handle));
  },
}).catch(console.error);
