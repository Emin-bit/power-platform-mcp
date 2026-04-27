import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";

export function registerApplication(server: McpServer) {
  server.tool(
    "application_list",
    "List Dataverse applications available from Microsoft Marketplace, optionally scoped to one env.",
    {
      environment: z.string().optional(),
      output: z.string().optional().describe("Optional output file path"),
      install_state: z.string().optional().describe("Filter by install state"),
    },
    async ({ environment, output, install_state }) => {
      const args = ["application", "list"];
      if (environment) args.push("--environment", environment);
      if (output) args.push("--output", output);
      if (install_state) args.push("--installState", install_state);
      return runAsTool({ toolName: "application_list", binary: "pac", args, timeoutMs: 60_000 });
    }
  );

  server.tool(
    "application_install",
    "Install or update a Dataverse application from Marketplace into the target env. Pass either application_name (single) or application_list (JSON file with batch).",
    {
      application_name: z.string().optional().describe("Unique name of one application to install"),
      application_list: z.string().optional().describe("Path to a .json file listing apps to install"),
      environment: z.string().optional(),
      confirm: z.boolean().describe("Must be true (creates resources / installs apps)"),
    },
    async ({ application_name, application_list, environment, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: application_install installs Marketplace apps into the env. Re-call with confirm=true." }] };
      if (!application_name && !application_list) {
        return { isError: true, content: [{ type: "text", text: "Pass application_name or application_list." }] };
      }
      const args = ["application", "install"];
      if (application_name) args.push("--application-name", application_name);
      if (application_list) args.push("--application-list", application_list);
      if (environment) args.push("--environment", environment);
      return runAsTool({ toolName: "application_install", binary: "pac", args, timeoutMs: 30 * 60_000 });
    }
  );
}
