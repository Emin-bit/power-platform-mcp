// pp_token — cross-platform bearer token helper for Dataverse / Power Apps REST APIs.
//
// Why: pac stores its auth tokens encrypted on disk (CrossPlatformCommandClient.config)
// and there's no documented `pac auth get-token` command. The Windows UX report's #8
// friction was that MSAL.PS PowerShell module crashes on Mac with System.Windows.Forms.
//
// Strategy (in order of preference):
//   1. Azure CLI: `az account get-access-token --resource <url> --query accessToken -o tsv`
//      Pros: most devs have it, cross-platform, no extra modules
//      Cons: user has to `az login` first
//   2. Az PowerShell (pwsh + Az.Accounts module): Get-AzAccessToken -ResourceUrl <url>
//      Pros: works when az CLI not present
//      Cons: extra module install
//
// Returned token is SHORT-LIVED (~1h). The tool description aggressively flags it as
// a secret so Claude doesn't paste it into a public chat.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { log } from "../logger.js";
import type { ToolResult } from "../runner.js";

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True if the binary wasn't found (ENOENT). */
  notFound: boolean;
}

function spawnAndCollect(cmd: string, args: string[], timeoutMs = 30_000): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let notFound = false;
    let child;
    try {
      child = spawn(cmd, args, { shell: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      resolve({
        stdout: "",
        stderr: (err as Error).message,
        exitCode: -1,
        notFound: code === "ENOENT",
      });
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

/** Try Azure CLI first. Returns the token on success, null on any kind of failure. */
async function tryAzCli(resourceUrl: string): Promise<{ token: string; method: string } | { error: string }> {
  const r = await spawnAndCollect("az", [
    "account", "get-access-token",
    "--resource", resourceUrl,
    "--query", "accessToken",
    "-o", "tsv",
  ]);
  if (r.notFound) return { error: "az: not found on PATH" };
  if (r.exitCode !== 0) {
    const stderr = r.stderr.trim();
    // Common az failure: "Please run 'az login'" — surface that directly.
    if (/az\s+login|not logged in|expired/i.test(stderr)) {
      return { error: `az: not authenticated — run 'az login --tenant <yourtenant>' first. Raw: ${stderr.slice(0, 200)}` };
    }
    return { error: `az exit ${r.exitCode}: ${stderr.slice(0, 300)}` };
  }
  const token = r.stdout.trim();
  if (!token || token.split(".").length !== 3) {
    return { error: "az returned an unexpected output (not a JWT)" };
  }
  return { token, method: "az" };
}

/** Try Az PowerShell module. Returns the token on success, null on any kind of failure. */
async function tryAzPowerShell(resourceUrl: string): Promise<{ token: string; method: string } | { error: string }> {
  // -NonInteractive so we don't hang on a prompt; user has to be already signed in via Connect-AzAccount.
  // Use 7.x pwsh binary which is cross-platform.
  const script =
    "$ErrorActionPreference='Stop'; " +
    "if (-not (Get-Module -ListAvailable Az.Accounts)) { Write-Error 'Az.Accounts module not installed'; exit 2 } " +
    "Import-Module Az.Accounts -ErrorAction Stop; " +
    `$t = Get-AzAccessToken -ResourceUrl '${resourceUrl.replace(/'/g, "''")}' -ErrorAction Stop; ` +
    "if ($t.Token -is [System.Security.SecureString]) { " +
    "  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($t.Token); " +
    "  try { [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } " +
    "  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) } " +
    "} else { $t.Token }";
  const r = await spawnAndCollect("pwsh", [
    "-NoLogo", "-NoProfile", "-NonInteractive",
    "-Command", script,
  ]);
  if (r.notFound) return { error: "pwsh: not found on PATH" };
  if (r.exitCode === 2) return { error: "pwsh has Az.Accounts module missing — run: pwsh -Command \"Install-Module Az.Accounts -Scope CurrentUser\"" };
  if (r.exitCode !== 0) {
    const stderr = r.stderr.trim();
    if (/connect-azaccount|not connected|not signed in/i.test(stderr)) {
      return { error: "pwsh + Az: not connected — run: pwsh -Command \"Connect-AzAccount -TenantId <yourtenant>\"" };
    }
    return { error: `pwsh+Az exit ${r.exitCode}: ${stderr.slice(0, 300)}` };
  }
  const token = r.stdout.trim();
  if (!token || token.split(".").length !== 3) {
    return { error: "pwsh+Az returned an unexpected output (not a JWT)" };
  }
  return { token, method: "pwsh+Az" };
}

export function registerPpToken(server: McpServer) {
  server.tool(
    "pp_token",
    "Acquire a short-lived bearer access token for a Dataverse / Power Apps / Power Automate API endpoint. " +
    "Phase E (1.2.0). Used internally by canvas_layer_* and other tools that call Dataverse Web API directly " +
    "(bypassing pac for surgical operations). Tries Azure CLI (`az account get-access-token`) first, falls back " +
    "to pwsh + Az.Accounts module. " +
    "⚠️ SECURITY: the returned token authorizes API calls on behalf of the signed-in user. Treat as a secret — " +
    "do not paste into chat logs or share. Token expires in ~1h. Re-call this tool to refresh. " +
    "PREREQ: user must have run `az login --tenant <yourtenant>` OR `Connect-AzAccount -TenantId <yourtenant>` " +
    "on this machine recently.",
    {
      resource_url: z.string().describe(
        "Target resource URL. Common values:\n" +
        "  - Dataverse env: 'https://<org>.crm.dynamics.com' (use env_who to get the right org)\n" +
        "  - Power Apps service: 'https://service.powerapps.com'\n" +
        "  - Power Automate service: 'https://service.flow.microsoft.com'",
      ),
      // Output-mode hint so we can suppress the token in serialized logs.
      reveal: z.boolean().default(false).describe(
        "When true, the returned tool response contains the full token. When false (default), the token is " +
        "redacted in the response (shown as last-N-chars + length) so it doesn't leak into chat transcripts. " +
        "Most internal callers want reveal:false; pass reveal:true only when you need to copy the token to a " +
        "Postman/curl command.",
      ),
    },
    async ({ resource_url, reveal }): Promise<ToolResult> => {
      log("info", "pp_token", { resource: resource_url, reveal });

      const azResult = await tryAzCli(resource_url);
      let final: { token: string; method: string } | null = null;
      const errors: string[] = [];
      if ("token" in azResult) {
        final = azResult;
      } else {
        errors.push(azResult.error);
        const psResult = await tryAzPowerShell(resource_url);
        if ("token" in psResult) {
          final = psResult;
        } else {
          errors.push(psResult.error);
        }
      }

      if (!final) {
        log("error", "pp_token done", { exitCode: 1, tried: errors });
        return {
          isError: true,
          content: [{
            type: "text",
            text:
              "pp_token failed to acquire a token. Tried in order:\n" +
              errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n") +
              "\n\nFix recommendation:\n" +
              "  Install Azure CLI (brew install azure-cli / scoop install azure-cli) and run:\n" +
              "    az login --tenant <yourtenant>\n" +
              "  Then retry pp_token.",
          }],
        };
      }

      log("info", "pp_token done", { exitCode: 0, method: final.method, tokenLength: final.token.length });

      const tail = final.token.slice(-12);
      const masked = `<${final.token.length} char JWT, ending in …${tail}>`;
      const text = reveal
        ? `Token acquired via ${final.method} (length ${final.token.length} chars):\n${final.token}\n\n⚠️ Treat as secret. Expires in ~1h.`
        : `Token acquired via ${final.method}: ${masked}\nRe-call with reveal:true to get the full token.`;

      return {
        // Mark the token as redacted in the runner pipeline too, so any downstream
        // formatting that might log this response can't accidentally print it.
        isError: false,
        content: [{ type: "text", text }],
      };
    },
  );
}
