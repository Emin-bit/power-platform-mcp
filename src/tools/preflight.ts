import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runPreflight, installPacTools, PAC_TOOL_PACKAGE, PACX_TOOL_PACKAGE } from "../setup.js";
import type { ToolResult } from "../runner.js";
import { log } from "../logger.js";

export function registerPreflight(server: McpServer) {
  server.tool(
    "preflight",
    "Diagnostic health check of the local Power Platform setup. Returns a structured report covering: Node version, .NET SDK, pac CLI, pacx CLI, PAC auth profiles, PACX auth profiles. " +
    "Read-only — does not modify the system. Each missing/error item includes an actionable 'fix' command. " +
    "ALWAYS call this first when troubleshooting why a tool is failing, or when onboarding a new machine.",
    {},
    async () => {
      log("info", "preflight");
      const r = await runPreflight();
      const text = `Power Platform MCP — preflight check\n\n${r.summary}\n\nOverall: ${r.allOk ? "✅ all systems go" : "⚠️ items need attention"}\n\nNext steps:\n  • If pac/pacx missing → call setup_install_pac_tools (with confirm:true) or run \`npx @emin-bit/power-platform-mcp setup\` in terminal\n  • If .NET SDK missing → install from https://dotnet.microsoft.com/download (cannot be auto-installed)\n  • If PAC auth missing → call auth_create_device_code or auth_create_interactive\n  • If PACX auth missing → call pacx_auth_create`;
      return {
        isError: !r.allOk,
        content: [{ type: "text", text }],
      };
    }
  );

  server.tool(
    "setup_install_pac_tools",
    `Install or update the pac and pacx .NET global tools (${PAC_TOOL_PACKAGE} and ${PACX_TOOL_PACKAGE}). ` +
    `Runs \`dotnet tool install --global\` for each. Requires .NET SDK to be already installed (this tool cannot install .NET SDK itself — that's OS-specific and requires admin in many cases). ` +
    `Skips packages that are already installed. After install, restart Claude Desktop so MCP picks up the new binaries on PATH. ` +
    `Requires confirm=true since this modifies your system (writes to ~/.dotnet/tools/).`,
    {
      confirm: z.boolean().describe("Must be true to actually run the installs."),
    },
    async ({ confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return {
          isError: true,
          content: [{ type: "text", text: "BLOCKED: setup_install_pac_tools modifies your system (installs .NET global tools to ~/.dotnet/tools/). Re-call with confirm=true to proceed." }],
        };
      }
      log("info", "setup_install_pac_tools");
      const res = await installPacTools();

      // Phase 1: mandatory prereqs (Node + .NET) — abort if missing
      if (!res.prereqs.ok) {
        const lines = [
          "❌ Mandatory prerequisites not satisfied. Cannot install pac/pacx.\n",
          `  Node.js: ${res.prereqs.node.status === "ok" ? "✅ v" + res.prereqs.node.version : "❌ " + (res.prereqs.node.detail ?? "not found")}`,
          `  .NET SDK: ${res.prereqs.dotnet.status === "ok" ? "✅ v" + res.prereqs.dotnet.version : "❌ " + (res.prereqs.dotnet.detail ?? "not found")}`,
          "",
          "Blockers:",
          ...res.prereqs.blockers.map(b => "  • " + b),
          "",
          "These cannot be auto-installed by this MCP — they need OS-level installs (often with admin rights).",
          "Once installed, re-call this tool with confirm=true.",
        ];
        return { isError: true, content: [{ type: "text", text: lines.join("\n") }] };
      }

      // Phase 2: install results
      const lines = [
        "Power Platform CLI tools — install result",
        "",
        "Phase 1 (prereqs): ✅ Node.js + .NET SDK verified",
        "Phase 2 (install):",
      ];
      for (const r of [res.pac, res.pacx]) {
        if (!r) continue;
        if (r.alreadyInstalled) {
          lines.push(`  ✓ ${r.package}: already installed (skipped)`);
        } else if (r.exitCode === 0) {
          lines.push(`  ✓ ${r.package}: newly installed`);
        } else {
          lines.push(`  ✗ ${r.package}: install failed (exit ${r.exitCode})`);
          if (r.stderr.trim()) lines.push(`    stderr: ${r.stderr.trim().split("\n").pop()}`);
        }
      }
      lines.push("");
      lines.push("Next: restart Claude Desktop so MCP detects the newly-installed binaries on PATH.");
      lines.push("Then call preflight to verify, and authenticate via auth_create_device_code if no PAC profiles exist.");
      const failed = [res.pac, res.pacx].some(r => r && !r.alreadyInstalled && r.exitCode !== 0);
      return {
        isError: failed,
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }
  );
}
