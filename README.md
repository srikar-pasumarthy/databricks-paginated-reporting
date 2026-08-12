# geisinger-paginated-reports

A Databricks App powered by [AppKit](https://developers.databricks.com/docs/appkit/v0/) for building
**grouped, paginated reports** (SSRS/Cognos style) over Unity Catalog tables, with a real
server-side **PDF export**.

## What it does

1. **Create a report** and give it a name.
2. **Choose a table** by browsing Unity Catalog (catalog → schema → table) on-behalf-of the user, so
   your UC grants apply.
3. **Pick the columns** to keep; each keeps its Unity Catalog type.
4. **Group / break by** one or more columns (nestable, reorderable). Each group value produces its own
   section in the output.
5. **Configure the summary row** per column: `sum`, `avg`, `min`, `max`, `count`, or none. Numeric
   aggregations (`sum`/`avg`/…) are only offered for numeric columns; the default is `avg` for
   rate/ratio/percent/score columns and `sum` for the rest.
6. **Preview** the banded result, then **Download PDF** — a real `.pdf` with repeating column headers,
   a band per group, a subtotal row at each group break, and a grand-total row.
7. **Schedule it by email** — send the report PDF to a list of recipients on a recurring schedule
   (daily / weekly / monthly presets, or a raw cron expression, in a chosen timezone).

### How it's built

- Two warehouse queries per render: a **bounded** detail `SELECT` (`ORDER BY` the group columns, capped
  at 50,000 rows so a huge table can't exhaust app memory), and a full-table **`GROUP BY ROLLUP`** that
  returns every group's subtotal *and* the grand total in one pass. Every identifier is validated against
  **live** UC metadata before it touches SQL, and backtick-quoted (with backtick-doubling) so column
  names with spaces or slashes work.
- `server/lib/report-model.ts` drives the banded structure and all summaries from the (small) ROLLUP
  result, attaching whatever detail rows were fetched. **Subtotals and the grand total are therefore
  exact for the full table even when the detail is capped** — which is what lets grouped summaries scale
  to very large tables (the work is O(groups), not O(rows)). The same line list feeds the JSON preview
  and the PDF, so what you preview is what you download.
- `server/lib/pdf.ts` renders those lines with [`pdfmake`](https://pdfmake.github.io/docs/) (pure JS,
  standard PDF fonts — no headless browser, which isn't viable in the Apps sandbox).
- Report configs, schedules, and a send audit log are stored in Lakebase Postgres
  (`greport.reports` / `greport.schedules` / `greport.send_log`), private to each report's owner.

### Email scheduling

- A schedule attaches recipients + a cadence to a report. Presets (daily/weekly/monthly + time) are
  compiled to a canonical cron string; a raw cron expression is also accepted. `next_run_at` is computed
  from the cron + IANA timezone (`server/lib/schedule.ts`, via `cron-parser`).
- Databricks Apps scale to zero, so the app can't run its own timer. Instead a **Databricks Job**
  (`geisinger-paginated-reports-scheduler`, cron every 15 min) authenticates as the app's service
  principal via OAuth M2M and calls `POST /api/scheduler/tick`, gated by a shared secret
  (`x-scheduler-token`). The tick finds due schedules, renders each PDF as the service principal, emails
  it, logs the attempt, and advances `next_run_at`. The Job script lives in `scheduler/tick_job.py`.
- **Email transport** (`server/lib/mailer.ts`) is `nodemailer` over SMTP, configured from environment
  variables. Until SMTP credentials are provided it runs in **preview mode**: schedules still fire and
  render, and each intended send is logged (status `preview`), but no mail leaves the app. Dropping the
  secrets in flips it to real delivery with no code change.

#### Enabling real email delivery

Add these keys to the app's secret scope (`geisinger_paginated_reports`) and expose them in `app.yaml`
via `valueFrom` (as `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, optional
`SMTP_SECURE=true`), then redeploy:

```bash
databricks secrets put-secret geisinger_paginated_reports smtp_host   --string-value smtp.example.com
databricks secrets put-secret geisinger_paginated_reports smtp_port   --string-value 587
databricks secrets put-secret geisinger_paginated_reports smtp_user   --string-value apikey-or-user
databricks secrets put-secret geisinger_paginated_reports smtp_pass   --string-value '••••••'
databricks secrets put-secret geisinger_paginated_reports smtp_from   --string-value 'Reports <reports@yourdomain.com>'
```

**Enabled plugins:**
- **Analytics** -- SQL query execution against Databricks SQL Warehouses
- **Lakebase** -- Fully managed Postgres database for transactional (OLTP) workloads on Databricks
- **Server** -- Express HTTP server with static file serving and Vite dev mode

## Prerequisites

- Node.js v22+ and npm
- Databricks CLI (for deployment)
- Access to a Databricks workspace

## Databricks Authentication

### Local Development

For local development, configure your environment variables by creating a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` and set the environment variables you need:

```env
DATABRICKS_HOST=https://your-workspace.cloud.databricks.com
DATABRICKS_APP_PORT=8000
# ... other environment variables, depending on the plugins you use
```

#### Lakebase Configuration

The Lakebase plugin requires additional environment variables for PostgreSQL connectivity. To learn how to configure the Lakebase plugin, see the [Lakebase plugin documentation](https://developers.databricks.com/docs/appkit/v0/plugins/lakebase).

### CLI Authentication

The Databricks CLI requires authentication to deploy and manage apps. Configure authentication using one of these methods:

#### OAuth U2M

Interactive browser-based authentication with short-lived tokens:

```bash
databricks auth login --host https://your-workspace.cloud.databricks.com
```

This will open your browser to complete authentication. The CLI saves credentials to `~/.databrickscfg`.

#### Configuration Profiles

Use multiple profiles for different workspaces:

```ini
[DEFAULT]
host = https://dev-workspace.cloud.databricks.com

[production]
host = https://prod-workspace.cloud.databricks.com
client_id = prod-client-id
client_secret = prod-client-secret
```

Deploy using a specific profile:

```bash
databricks bundle deploy --profile production
```

**Note:** Personal Access Tokens (PATs) are legacy authentication. OAuth is strongly recommended for better security.

## Getting Started

### Install Dependencies

```bash
npm install
```

### Development

Run the app in development mode with hot reload:

```bash
npm run dev
```

The app will be available at the URL shown in the console output.

### Build

Build both client and server for production:

```bash
npm run build
```

This creates:

- `dist/server.js` - Compiled server bundle
- `client/dist/` - Bundled client assets

### Production

Run the production build:

```bash
npm start
```

## Code Quality

There are a few commands to help you with code quality:

```bash
# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Formatting
npm run format
npm run format:fix
```

## Deployment with Databricks Asset Bundles

### 1. Configure Bundle

Update `databricks.yml` with your workspace settings:

```yaml
targets:
  default:
    workspace:
      host: https://your-workspace.cloud.databricks.com
```

Make sure to replace all placeholder values in `databricks.yml` with your actual resource IDs.

### 2. Deploy

Deploy and start the app with a single command:

```bash
databricks apps deploy
```

`databricks apps deploy` validates the project, deploys it, starts the app, and prints its URL.

### Deploy to Production

1. Configure the production target in `databricks.yml`
2. Deploy to production:

```bash
databricks apps deploy -t prod
```

> **Restarting a stopped app:** apps stop after a period of inactivity. To start one again without redeploying, run `databricks apps start <APP_NAME>`.

## Project Structure

```
* client/          # React frontend
  * src/           # Source code
  * public/        # Static assets
* server/          # Express backend
  * server.ts      # Server entry point
  * routes/        # Routes
* shared/          # Shared types
* config/          # Configuration
  * queries/       # SQL query files
* databricks.yml   # Bundle configuration
* app.yaml         # App configuration
* .env.example     # Environment variables example
```

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: React.js, TypeScript, Vite, Tailwind CSS, React Router
- **UI Components**: Radix UI, shadcn/ui
- **Databricks**: AppKit SDK
