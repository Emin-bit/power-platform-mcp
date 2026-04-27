import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runAsTool } from "../runner.js";

export function registerTelemetry(server: McpServer) {
  server.tool(
    "telemetry_status",
    "Show the current PAC CLI telemetry opt-in status (whether usage info is sent to Microsoft).",
    {},
    async () => runAsTool({ toolName: "telemetry_status", binary: "pac", args: ["telemetry", "status"], timeoutMs: 15_000 })
  );

  server.tool(
    "telemetry_enable",
    "Opt in to PAC CLI telemetry (send usage info to Microsoft to help improve the product). Local-only setting.",
    {},
    async () => runAsTool({ toolName: "telemetry_enable", binary: "pac", args: ["telemetry", "enable"], timeoutMs: 15_000 })
  );

  server.tool(
    "telemetry_disable",
    "Opt out of PAC CLI telemetry. Local-only setting.",
    {},
    async () => runAsTool({ toolName: "telemetry_disable", binary: "pac", args: ["telemetry", "disable"], timeoutMs: 15_000 })
  );
}
