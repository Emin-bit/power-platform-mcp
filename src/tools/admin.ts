import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool } from "../runner.js";

// Read-only admin tools. Destructive ones (admin delete/reset/restore/copy/create) belong in
// Phase 3 (long-running) or stay accessible via pac_run with confirm:true.

export function registerAdmin(server: McpServer) {
  server.tool(
    "admin_env_list",
    "List ALL environments in the tenant. Requires Power Platform admin / Global admin role. For non-admin users, use env_list (which queries Global Discovery Service from the user's perspective).",
    {
      type: z.enum(["Trial", "Sandbox", "Production", "Developer", "Teams", "SubscriptionBasedTrial"]).optional().describe("Filter by environment type"),
      name: z.string().optional().describe("Substring filter on environment display name"),
      environment: z.string().optional().describe("Substring filter on environment ID or URL"),
      application: z.string().optional().describe("Filter envs that have a specific application installed (unique name or ID)"),
    },
    async ({ type, name, environment, application }) => {
      const args = ["admin", "list"];
      if (type) args.push("--type", type);
      if (name) args.push("--name", name);
      if (environment) args.push("--environment", environment);
      if (application) args.push("--application", application);
      return runAsTool({
        toolName: "admin_env_list",
        binary: "pac",
        args,
        timeoutMs: 120_000,
      });
    }
  );

  server.tool(
    "admin_status",
    "List the status of all admin operations currently in progress in the tenant (e.g. environment copy/backup/restore/delete jobs).",
    {},
    async () => runAsTool({
      toolName: "admin_status",
      binary: "pac",
      args: ["admin", "status"],
      timeoutMs: 60_000,
    })
  );

  server.tool(
    "admin_list_backups",
    "List all backups of an environment. Defaults to active environment.",
    {
      environment: z.string().optional().describe("Environment ID or URL substring; defaults to active"),
    },
    async ({ environment }) => {
      const args = ["admin", "list-backups"];
      if (environment) args.push("--environment", environment);
      return runAsTool({
        toolName: "admin_list_backups",
        binary: "pac",
        args,
        timeoutMs: 60_000,
      });
    }
  );

  server.tool(
    "admin_list_tenant_settings",
    "List tenant-level Power Platform settings (DLP scope, governance, etc). Requires admin role.",
    {},
    async () => runAsTool({
      toolName: "admin_list_tenant_settings",
      binary: "pac",
      args: ["admin", "list-tenant-settings"],
      timeoutMs: 60_000,
    })
  );

  server.tool(
    "admin_list_groups",
    "List environment groups in the tenant. Requires admin role.",
    {},
    async () => runAsTool({
      toolName: "admin_list_groups",
      binary: "pac",
      args: ["admin", "list-groups"],
      timeoutMs: 60_000,
    })
  );

  server.tool(
    "admin_list_app_templates",
    "List all supported Dataverse templates of model-driven apps (Dynamics 365 templates).",
    {},
    async () => runAsTool({
      toolName: "admin_list_app_templates",
      binary: "pac",
      args: ["admin", "list-app-templates"],
      timeoutMs: 60_000,
    })
  );
}
