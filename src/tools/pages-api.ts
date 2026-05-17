// Power Pages admin API tools — Phase H (v1.3.0).
//
// WHY THIS EXISTS: a 30-day production analysis of a real Power Pages project
// (beanstandung.powerappsportals.com) graded the MCP 6/10 and identified ONE
// blocking gap: after `pages_upload`, changes don't appear because the
// server-side cache still serves the old content. `pac` has NO cache-clear
// command. The team had to drive a browser (Chrome MCP) to Design Studio and
// click "Sync" — a 5-15 minute, multi-retry, auth-fragile dance that negated
// the whole point of automation.
//
// The reliable PROGRAMMATIC equivalent of "Sync": restart the website via the
// Power Platform admin API. A restart flushes ALL server-side cache (metadata
// + configuration + data tables). This is documented and stable, unlike the
// authenticated `/_services/about` clear-cache page (which needs a portal web
// role + portal auth cookie and is exactly the fragile path the team hated).
//
// API: https://api.powerplatform.com/powerpages/environments/{envId}/websites/{websiteId}/restart?api-version=2022-03-01-preview
// Reference: https://learn.microsoft.com/rest/api/power-platform/powerpages/websites
// Auth: bearer for resource https://api.powerplatform.com (user-delegated;
//       service principal flow is NOT supported by these admin APIs — the token
//       owner must have the Power Pages admin roles). We acquire it the same way
//       pp_token / canvas_layer_* do: az CLI first, pwsh+Az.Accounts fallback.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { log, logTruncate } from "../logger.js";
import type { ToolResult } from "../runner.js";

const PP_API_RESOURCE = "https://api.powerplatform.com";
const PP_API_VERSION = "2022-03-01-preview";

interface SpawnResult { stdout: string; stderr: string; exitCode: number; notFound: boolean; }

function spawnAndCollect(cmd: string, args: string[], timeoutMs = 60_000): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { shell: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      resolve({ stdout: "", stderr: (err as Error).message, exitCode: -1, notFound: code === "ENOENT" });
      return;
    }
    const t = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* noop */ } }, timeoutMs);
    child.stdout?.on("data", d => { stdout += d.toString(); });
    child.stderr?.on("data", d => { stderr += d.toString(); });
    child.on("error", err => {
      clearTimeout(t);
      const code = (err as NodeJS.ErrnoException).code;
      resolve({ stdout, stderr: stderr || (err as Error).message, exitCode: -1, notFound: code === "ENOENT" });
    });
    child.on("close", code => { clearTimeout(t); resolve({ stdout, stderr, exitCode: code ?? -1, notFound: false }); });
  });
}

/**
 * Acquire a bearer token for the Power Platform admin API. Mirrors the proven
 * pp_token / canvas_layer_* acquisition: az CLI first, pwsh+Az.Accounts fallback.
 * Fails with an actionable message — never silently returns a bad token.
 */
async function acquireToken(): Promise<{ token: string } | { error: string }> {
  const azR = await spawnAndCollect("az", [
    "account", "get-access-token",
    "--resource", PP_API_RESOURCE,
    "--query", "accessToken", "-o", "tsv",
  ]);
  if (!azR.notFound && azR.exitCode === 0) {
    const tok = azR.stdout.trim();
    if (tok.split(".").length === 3) return { token: tok };
  }
  const psScript =
    "$ErrorActionPreference='Stop'; " +
    "if (-not (Get-Module -ListAvailable Az.Accounts)) { exit 2 } " +
    "Import-Module Az.Accounts -ErrorAction Stop; " +
    `$t = Get-AzAccessToken -ResourceUrl '${PP_API_RESOURCE}' -ErrorAction Stop; ` +
    "if ($t.Token -is [System.Security.SecureString]) { " +
    "  $b=[System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($t.Token); " +
    "  try { [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } " +
    "  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) } " +
    "} else { $t.Token }";
  const psR = await spawnAndCollect("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", psScript]);
  if (!psR.notFound && psR.exitCode === 0) {
    const tok = psR.stdout.trim();
    if (tok.split(".").length === 3) return { token: tok };
  }
  return {
    error:
      "Could not acquire a Power Platform API bearer token. Tried `az account get-access-token` " +
      "(recommended) and `pwsh + Az.Accounts`. Fix: install Azure CLI and run " +
      "`az login --tenant <yourtenant>` once on this machine, then retry. " +
      "NOTE: Power Pages admin APIs do NOT support the service-principal flow — the signed-in " +
      "user must hold the Power Pages / Power Platform admin role. " +
      `Raw: az=[${azR.notFound ? "not found" : azR.stderr.slice(0, 80)}], pwsh=[${psR.notFound ? "not found" : psR.stderr.slice(0, 80)}]`,
  };
}

async function ppApi(
  method: "GET" | "POST",
  path: string,
  token: string,
): Promise<{ ok: true; data: unknown; status: number } | { ok: false; error: string; status: number }> {
  const url = `${PP_API_RESOURCE}/powerpages/${path}${path.includes("?") ? "&" : "?"}api-version=${PP_API_VERSION}`;
  let res: Response;
  try {
    // Restart is a PARAMETERLESS action. Sending a JSON body (even `{}`) risks a 400 on
    // some Power Platform action endpoints — agent-review hardening: send NO body and no
    // Content-Type for POST. If a future operation needs a payload, branch on `path`.
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return { ok: false, error: `network error: ${(err as Error).message}`, status: -1 };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = text.slice(0, 400);
    try { const j = JSON.parse(text); msg = j.error?.message ?? j.message ?? msg; } catch { /* keep raw */ }
    return { ok: false, error: msg, status: res.status };
  }
  if (!text) return { ok: true, data: null, status: res.status };
  try { return { ok: true, data: JSON.parse(text), status: res.status }; }
  catch { return { ok: true, data: text, status: res.status }; }
}

export function registerPagesApi(server: McpServer) {
  // ---------- pages_restart — THE cache-clear (the #1 production blocker) ----------
  server.tool(
    "pages_restart",
    "Restart a Power Pages website via the Power Platform admin API. THIS IS THE RELIABLE PROGRAMMATIC " +
    "CACHE-CLEAR: a restart flushes ALL server-side cache (metadata, configuration, AND data tables), so " +
    "changes made by pages_upload / pages_upload_code_site / direct Dataverse edits become visible " +
    "immediately. Use this instead of the Design Studio 'Sync' button / browser automation — that path " +
    "(`/_services/about` clear-cache) needs a portal web role + portal auth cookie and is fragile. " +
    "DESTRUCTIVE-ish: a restart causes a brief outage (seconds) + temporary post-restart slowness while " +
    "the cache re-warms; do it during non-peak hours for high-traffic sites. " +
    "PREREQ: `az login --tenant <yourtenant>` (or `Connect-AzAccount`) by a user with the Power Pages / " +
    "Power Platform admin role (service-principal flow is NOT supported by this API). Phase H (v1.3.0).",
    {
      environment_id: z.string().describe(
        "Environment ID (GUID) that hosts the site. Get it from `env_who` (the 'Environment ID' line) or " +
        "the Power Platform admin center. NOT the org URL — the GUID.",
      ),
      website_id: z.string().describe("Power Pages website ID (GUID) — from pages_list."),
      confirm: z.boolean().describe("Must be true. Restart causes a brief outage + cache re-warm slowness."),
    },
    async ({ environment_id, website_id, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text:
              "BLOCKED: pages_restart restarts the live Power Pages site (brief outage + temporary " +
              "post-restart slowness while server-side cache re-warms). This IS the correct way to make " +
              "uploaded changes appear. Re-call with confirm=true. Prefer non-peak hours for busy sites.",
          }],
        };
      }
      log("info", "pages_restart", { environment_id, website_id });
      const tok = await acquireToken();
      if ("error" in tok) {
        log("error", "pages_restart done", { exitCode: 1, stderr: logTruncate(tok.error) });
        return { isError: true, content: [{ type: "text", text: tok.error }] };
      }
      const r = await ppApi("POST", `environments/${encodeURIComponent(environment_id)}/websites/${encodeURIComponent(website_id)}/restart`, tok.token);
      if (!r.ok) {
        log("error", "pages_restart done", { exitCode: 1, status: r.status, stderr: logTruncate(r.error) });
        const hint =
          r.status === 401 || r.status === 403
            ? "\nHint: token lacks Power Pages admin rights. The signed-in az/pwsh user must hold the Power Platform / Power Pages admin role (service principals are not supported here)."
            : r.status === 404
              ? "\nHint: 404 — check environment_id (must be the env GUID from env_who, not the org URL) and website_id (GUID from pages_list)."
              : "";
        return { isError: true, content: [{ type: "text", text: `Power Platform API error (${r.status}): ${r.error}${hint}` }] };
      }
      log("info", "pages_restart done", { exitCode: 0, status: r.status });
      return {
        content: [{
          type: "text",
          text:
            `✓ Restart accepted for website ${website_id} (HTTP ${r.status}).\n` +
            "Server-side cache is being flushed. The site is briefly unavailable, then re-warms over the " +
            "next minute or two. Verify your uploaded changes on the live site after ~60-90s.\n" +
            (r.data ? `\nAPI response: ${logTruncate(JSON.stringify(r.data), 400)}` : ""),
        }],
      };
    },
  );

  // ---------- pages_site_status — read-only diagnostics (P3 in the analysis) ----------
  server.tool(
    "pages_site_status",
    "Read Power Pages website details/status via the Power Platform admin API: provisioning state, data " +
    "model version, type, URLs, etc. Read-only. Useful for the 'is my restart done / what data model is " +
    "this site on' diagnostics the production analysis asked for (portal diagnostics without a browser). " +
    "Omit website_id to list ALL websites in the environment. Phase H (v1.3.0).",
    {
      environment_id: z.string().describe("Environment ID (GUID) — from env_who."),
      website_id: z.string().optional().describe("Specific website ID (GUID). Omit to list all sites in the environment."),
    },
    async ({ environment_id, website_id }): Promise<ToolResult> => {
      log("info", "pages_site_status", { environment_id, website_id: website_id ?? "(all)" });
      const tok = await acquireToken();
      if ("error" in tok) {
        log("error", "pages_site_status done", { exitCode: 1, stderr: logTruncate(tok.error) });
        return { isError: true, content: [{ type: "text", text: tok.error }] };
      }
      const path = website_id
        ? `environments/${encodeURIComponent(environment_id)}/websites/${encodeURIComponent(website_id)}`
        : `environments/${encodeURIComponent(environment_id)}/websites`;
      const r = await ppApi("GET", path, tok.token);
      if (!r.ok) {
        log("error", "pages_site_status done", { exitCode: 1, status: r.status, stderr: logTruncate(r.error) });
        const hint = r.status === 401 || r.status === 403
          ? "\nHint: token lacks Power Pages admin rights (service-principal flow not supported by this API)."
          : r.status === 404 ? "\nHint: 404 — check environment_id GUID (from env_who) and website_id GUID (from pages_list)." : "";
        return { isError: true, content: [{ type: "text", text: `Power Platform API error (${r.status}): ${r.error}${hint}` }] };
      }
      log("info", "pages_site_status done", { exitCode: 0, status: r.status });
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    },
  );
}
