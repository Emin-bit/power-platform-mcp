// canvas_layer_inspect / canvas_layer_remove — Phase E (1.2.0).
//
// Why: the Windows UX report friction #4 was an "active unmanaged layer" from
// "Standardherausgeber" that blocked every solution import for canvas apps.
// The user couldn't remove it from Studio UI. The Dataverse SDK has a dedicated
// message for this: `RemoveActiveCustomizationsRequest`. PAC doesn't expose it.
// We hit the Web API directly.
//
// API reference:
//   - RetrieveSolutionComponentLayers (read):
//     https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrievesolutioncomponentlayers
//   - RemoveActiveCustomizations (write):
//     https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/removeactivecustomizations
//
// Component type ids relevant here:
//   - 300 = Canvas App (logical name: canvasapp)
//   - 91  = Plugin Assembly
//   - 80  = Entity (table)
//   - 24  = Saved Query (view)
// We default to 300 since the tool is canvas-focused but allow override.
//
// Token flow: caller must have run `az login` (or `Connect-AzAccount`) on the
// machine. We call pp_token internally via the same spawn helpers; if the token
// can't be acquired we surface the same fix hints pp_token emits.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { log, logTruncate } from "../logger.js";
import type { ToolResult } from "../runner.js";

const DEFAULT_TIMEOUT_MS = 60_000;

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  notFound: boolean;
}

function spawnAndCollect(cmd: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { shell: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      resolve({ stdout: "", stderr: (err as Error).message, exitCode: -1, notFound: code === "ENOENT" });
      return;
    }
    const t = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* noop */ }
    }, timeoutMs);
    child.stdout?.on("data", d => { stdout += d.toString(); });
    child.stderr?.on("data", d => { stderr += d.toString(); });
    child.on("error", err => {
      clearTimeout(t);
      const code = (err as NodeJS.ErrnoException).code;
      resolve({ stdout, stderr: stderr || (err as Error).message, exitCode: -1, notFound: code === "ENOENT" });
    });
    child.on("close", code => {
      clearTimeout(t);
      resolve({ stdout, stderr, exitCode: code ?? -1, notFound: false });
    });
  });
}

/**
 * Acquire a bearer token for the Dataverse env. Tries az CLI first (most common),
 * falls back to pwsh + Az.Accounts. Returns either { token } or { error }.
 *
 * This is intentionally duplicated from pp_token.ts (rather than imported) because
 * pp_token is an MCP tool that returns a ToolResult — we need the raw token here
 * for downstream HTTP calls, and the duplication keeps the dependency graph flat.
 */
async function acquireToken(envUrl: string): Promise<{ token: string } | { error: string }> {
  // Strip trailing slash — Dataverse rejects double slashes in some endpoints.
  const url = envUrl.replace(/\/+$/, "");

  // Try az first.
  const azR = await spawnAndCollect("az", [
    "account", "get-access-token",
    "--resource", url,
    "--query", "accessToken",
    "-o", "tsv",
  ]);
  if (!azR.notFound && azR.exitCode === 0) {
    const tok = azR.stdout.trim();
    if (tok.split(".").length === 3) return { token: tok };
  }
  // Try pwsh + Az.Accounts.
  const psScript =
    "$ErrorActionPreference='Stop'; " +
    "if (-not (Get-Module -ListAvailable Az.Accounts)) { exit 2 } " +
    "Import-Module Az.Accounts -ErrorAction Stop; " +
    `$t = Get-AzAccessToken -ResourceUrl '${url.replace(/'/g, "''")}' -ErrorAction Stop; ` +
    "if ($t.Token -is [System.Security.SecureString]) { " +
    "  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($t.Token); " +
    "  try { [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } " +
    "  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) } " +
    "} else { $t.Token }";
  const psR = await spawnAndCollect("pwsh", [
    "-NoLogo", "-NoProfile", "-NonInteractive",
    "-Command", psScript,
  ]);
  if (!psR.notFound && psR.exitCode === 0) {
    const tok = psR.stdout.trim();
    if (tok.split(".").length === 3) return { token: tok };
  }
  return {
    error:
      "Could not acquire bearer token. Tried 'az account get-access-token' (recommended) and 'pwsh + Az.Accounts'. " +
      "Fix: install Azure CLI and run `az login --tenant <yourtenant>` once on this machine. " +
      `Raw errors: az=[${azR.notFound ? "not found" : azR.stderr.slice(0, 80)}], ` +
      `pwsh=[${psR.notFound ? "not found" : psR.stderr.slice(0, 80)}]`,
  };
}

interface DataverseError {
  error: { code: string; message: string };
}

async function dataverseFetch(
  envUrl: string,
  token: string,
  pathAndQuery: string,
  init?: RequestInit,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string; status: number }> {
  const url = envUrl.replace(/\/+$/, "") + "/api/data/v9.2/" + pathAndQuery.replace(/^\/+/, "");
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    "Content-Type": "application/json",
    "Prefer": "odata.include-annotations=*",
    ...(init?.headers as Record<string, string> | undefined ?? {}),
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch {}
    let parsed: DataverseError | null = null;
    try { parsed = JSON.parse(body); } catch {}
    const msg = parsed?.error
      ? `${parsed.error.code}: ${parsed.error.message}`
      : body.slice(0, 400);
    return { ok: false, error: msg, status: res.status };
  }
  const text = await res.text();
  if (!text) return { ok: true, data: null };
  try { return { ok: true, data: JSON.parse(text) }; } catch {
    return { ok: true, data: text };
  }
}

export function registerCanvasLayer(server: McpServer) {
  // ---------- canvas_layer_inspect ----------
  server.tool(
    "canvas_layer_inspect",
    "Inspect the solution component layers for a canvas app (or any Dataverse component). " +
    "Calls Dataverse Web API `RetrieveSolutionComponentLayers` directly — there is no PAC equivalent. " +
    "Use this when a `solution import` keeps failing with 'active layer of <publisher> blocks import' and " +
    "you need to see which publisher / solution actually owns the active layer. " +
    "PREREQ: `az login --tenant <yourtenant>` (or `Connect-AzAccount`) on this machine. Phase E (1.2.0).",
    {
      env_url: z.string().describe(
        "Dataverse environment URL (e.g. 'https://contoso.crm4.dynamics.com'). " +
        "Find it with `env_who` or `env_list`.",
      ),
      component_id: z.string().describe(
        "GUID of the component whose layers to inspect. For a canvas app, this is the canvas app's record GUID — " +
        "use `canvas_list` to find it (the `App ID` column).",
      ),
      component_type: z.number().int().default(300).describe(
        "Dataverse component type code. Default 300 (Canvas App). Other useful values: 91 (Plugin Assembly), " +
        "80 (Entity), 24 (Saved Query).",
      ),
    },
    async ({ env_url, component_id, component_type }): Promise<ToolResult> => {
      log("info", "canvas_layer_inspect", { env_url, component_id, component_type });
      const tok = await acquireToken(env_url);
      if ("error" in tok) {
        log("error", "canvas_layer_inspect done", { exitCode: 1, stderr: logTruncate(tok.error) });
        return { isError: true, content: [{ type: "text", text: tok.error }] };
      }
      // The Dataverse function call format: GET /RetrieveSolutionComponentLayers(ComponentId=<guid>,ComponentType=<int>)
      const path = `RetrieveSolutionComponentLayers(ComponentId=${encodeURIComponent(component_id)},ComponentType=${component_type})`;
      const result = await dataverseFetch(env_url, tok.token, path);
      if (!result.ok) {
        log("error", "canvas_layer_inspect done", { exitCode: 1, status: result.status, stderr: logTruncate(result.error) });
        const hint = result.status === 404
          ? "\nHint: 404 usually means the component_id doesn't exist (typo in GUID) or component_type is wrong."
          : result.status === 401 || result.status === 403
            ? "\nHint: the bearer token doesn't have access to this env. Make sure your az/pwsh session is signed into the SAME tenant + has at least System Customizer role."
            : "";
        return { isError: true, content: [{ type: "text", text: `Dataverse Web API error (${result.status}): ${result.error}${hint}` }] };
      }
      log("info", "canvas_layer_inspect done", { exitCode: 0 });
      const data = result.data as { value?: unknown[] } | null;
      // Phase E review fix (important #3): distinguish "API returned empty result"
      // (component isn't in any solution) from "API returned something we don't know
      // how to read" (Dataverse changed the response shape). Both used to show
      // identical "No layers found" — silent-success class.
      if (!data || typeof data !== "object") {
        return {
          content: [{
            type: "text",
            text:
              `Dataverse Web API returned a non-object response. Raw: ${JSON.stringify(data).slice(0, 400)}.\n` +
              `This may indicate an API contract change — file a bug if you can reproduce on a tenant where ` +
              `the component is known to exist.`,
          }],
        };
      }
      const rows = Array.isArray(data.value) ? data.value : null;
      if (rows === null) {
        return {
          content: [{
            type: "text",
            text:
              `Dataverse Web API returned an object but no \`value\` array. Raw: ${JSON.stringify(data).slice(0, 400)}.\n` +
              `Expected shape: { value: [{ msdyn_solutioncomponentname, msdyn_order, ... }, ...] }.`,
          }],
        };
      }
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No solution layers found for component ${component_id} (type ${component_type}). The component may not be in any solution, or the GUID/type is wrong.` }] };
      }
      // Project a compact summary alongside the full JSON for downstream tools.
      const summary: string[] = [];
      summary.push(`Found ${rows.length} layer(s) for component ${component_id} (type ${component_type}):`);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] as Record<string, unknown>;
        const publisher = r.msdyn_solutioncomponentname ?? r.publishername ?? r.solutionname ?? "(unknown)";
        const order = r.msdyn_order ?? r.order ?? "?";
        const layerType = r.layertype ?? r.solutionversion ?? "?";
        summary.push(`  ${i + 1}. publisher/solution=${publisher}, order=${order}, type=${layerType}`);
      }
      summary.push("");
      summary.push("--- raw JSON ---");
      summary.push(JSON.stringify(data, null, 2));
      return { content: [{ type: "text", text: summary.join("\n") }] };
    },
  );

  // ---------- canvas_layer_remove ----------
  server.tool(
    "canvas_layer_remove",
    "DESTRUCTIVE — CANNOT BE UNDONE. Removes the ACTIVE unmanaged customization layer of a canvas app (or " +
    "other Dataverse component). Calls Dataverse Web API action `RemoveActiveCustomizations` directly. " +
    "Unblocks solution imports when an existing active layer from a different publisher prevents updating the component. " +
    "DOES NOT delete the component itself — but any manual edits made via Studio on the active layer WILL BE LOST. " +
    "Inspect first with canvas_layer_inspect to confirm which layer you're about to remove. " +
    "PREREQ: `az login --tenant <yourtenant>` (or `Connect-AzAccount`). System Customizer or System Administrator role on the env. " +
    "Phase E (1.2.0).",
    {
      env_url: z.string().describe("Dataverse environment URL — find with env_who"),
      component_id: z.string().describe("GUID of the canvas app (or other component) whose active layer to remove"),
      solution_component_name: z.string().default("canvasapp").describe(
        "Entity LOGICAL NAME (string) of the component being mutated — `canvasapp` for canvas apps " +
        "(default), `Attribute` for columns, `SavedQuery` for views, etc. " +
        "This matches the SDK message RemoveActiveCustomizationsRequest.SolutionComponentName parameter " +
        "(string), not the numeric ComponentType used by RetrieveSolutionComponentLayers.",
      ),
      confirm: z.boolean().describe("Must be true. Safe-mode gate — this is destructive and cannot be undone."),
    },
    async ({ env_url, component_id, solution_component_name, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text:
              "BLOCKED: canvas_layer_remove removes the active unmanaged customization layer from a Dataverse component. " +
              "THIS CANNOT BE UNDONE — any manual Studio edits on the active layer will be lost permanently. " +
              "Before confirming, call canvas_layer_inspect on the same component to verify which layer you're removing. " +
              "Re-call with confirm:true to proceed.",
          }],
        };
      }
      log("info", "canvas_layer_remove", { env_url, component_id, solution_component_name });
      const tok = await acquireToken(env_url);
      if ("error" in tok) {
        log("error", "canvas_layer_remove done", { exitCode: 1, stderr: logTruncate(tok.error) });
        return { isError: true, content: [{ type: "text", text: tok.error }] };
      }
      // Critical Phase E fix (post-agent-review): Microsoft's canonical Web API call for
      // RemoveActiveCustomizationsRequest takes `SolutionComponentName` (string, e.g.
      // "canvasapp", "Attribute") and `ComponentId` (GUID) — NOT `SolutionComponentId`
      // + integer `ComponentType`. The earlier code used wrong field names and would
      // have been the exact silent-success class of bug this tool was meant to fix.
      // Reference: Dataverse SDK message `RemoveActiveCustomizationsRequest`.
      const result = await dataverseFetch(env_url, tok.token, "RemoveActiveCustomizations", {
        method: "POST",
        body: JSON.stringify({
          SolutionComponentName: solution_component_name,
          ComponentId: component_id,
        }),
      });
      if (!result.ok) {
        log("error", "canvas_layer_remove done", { exitCode: 1, status: result.status, stderr: logTruncate(result.error) });
        const hint = result.status === 401 || result.status === 403
          ? "\nHint: insufficient privileges. RemoveActiveCustomizations requires System Customizer or System Administrator role."
          : result.status === 404
            ? "\nHint: component not found. Check component_id GUID and solution_component_name (entity logical name like 'canvasapp')."
            : result.status === 400
              ? "\nHint: 400 usually means SolutionComponentName is wrong (must be the entity logical name like 'canvasapp', not a number)."
              : "";
        return { isError: true, content: [{ type: "text", text: `Dataverse Web API error (${result.status}): ${result.error}${hint}` }] };
      }
      // Capture any response payload so we can audit the action's actual return value.
      log("info", "canvas_layer_remove done", {
        exitCode: 0,
        status: 200,
        responseSummary: result.data ? logTruncate(JSON.stringify(result.data)) : "(empty body)",
      });
      return {
        content: [{
          type: "text",
          text:
            `✓ Active customization layer removed for ${solution_component_name} ${component_id}.\n` +
            `Verify with canvas_layer_inspect. You can now retry the solution import that was previously blocked by the active layer.`,
        }],
      };
    },
  );
}
