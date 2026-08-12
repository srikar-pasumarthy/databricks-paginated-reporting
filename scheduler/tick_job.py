# Databricks Job task: poke the app's /api/scheduler/tick endpoint.
#
# Runs on a cron schedule (every 15 min). Databricks Apps sit behind workspace
# OAuth, so we authenticate as a service principal via OAuth M2M (client
# credentials), which yields an access token the Apps proxy accepts. We also
# pass the shared scheduler token so the app knows the call came from the
# trusted scheduler.
#
# Secrets (scope: geisinger_paginated_reports):
#   - scheduler_token    shared gate token
#   - sp_client_id       service-principal application (client) id
#   - sp_client_secret   service-principal OAuth secret
#
# Job parameters: app_url, secret_scope, workspace_host.

import sys
import urllib.request
import urllib.error

from databricks.sdk import WorkspaceClient
from databricks.sdk.runtime import dbutils


def main() -> None:
    app_url = dbutils.widgets.get("app_url").rstrip("/")
    scope = dbutils.widgets.get("secret_scope")
    host = dbutils.widgets.get("workspace_host")

    scheduler_token = dbutils.secrets.get(scope=scope, key="scheduler_token")
    client_id = dbutils.secrets.get(scope=scope, key="sp_client_id")
    client_secret = dbutils.secrets.get(scope=scope, key="sp_client_secret")

    # OAuth M2M: mint an access token as the service principal.
    w = WorkspaceClient(
        host=host,
        client_id=client_id,
        client_secret=client_secret,
        auth_type="oauth-m2m",
    )
    access_token = w.config.oauth_token().access_token

    url = f"{app_url}/api/scheduler/tick"
    req = urllib.request.Request(url, method="POST", data=b"{}")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-scheduler-token", scheduler_token)
    req.add_header("Authorization", f"Bearer {access_token}")

    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = resp.read().decode("utf-8")
            print(f"tick OK ({resp.status}): {body}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        print(f"tick FAILED ({e.code}): {detail}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
