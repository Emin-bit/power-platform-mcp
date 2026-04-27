import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";

// IMPORTANT: PACX maintains its OWN authentication profiles, separate from PAC.
// pacx_auth_* tools manage those profiles. pac auth profiles are NOT visible to pacx.

export function registerPacxAuth(server: McpServer) {
  server.tool(
    "pacx_auth_list",
    "List PACX authentication profiles. Note: PACX has its own profile store, separate from PAC. PACX profiles are not the same as PAC profiles.",
    {},
    async () => runAsTool({
      toolName: "pacx_auth_list", binary: "pacx",
      args: ["auth", "list"], timeoutMs: 15_000,
    })
  );

  server.tool(
    "pacx_auth_create",
    "Create or update a PACX auth profile. PACX supports OAuth (interactive, default), Service Principal (with client_secret), and arbitrary connection strings. " +
    "Pass either: (a) just `name` + `environment` for OAuth interactive, (b) `name` + `environment` + `application_id` + `client_secret` for SP, or (c) `name` + `connection_string` for an arbitrary CRM connection string.",
    {
      name: z.string().max(30).describe("Profile name (max 30 chars)"),
      environment: z.string().optional().describe("Environment URL (for OAuth or SP)"),
      application_id: z.string().optional().describe("SP Application (client) ID"),
      client_secret: z.string().optional().describe("SP client secret (forwarded to pacx, never logged)"),
      connection_string: z.string().optional().describe("Full Dataverse connection string (alternative to env+SP)"),
    },
    async ({ name, environment, application_id, client_secret, connection_string }) => {
      const args = ["auth", "create", "--name", name];
      if (environment) args.push("--environment", environment);
      if (application_id) args.push("--applicationId", application_id);
      if (client_secret) args.push("--clientSecret", client_secret);
      if (connection_string) args.push("--conn", connection_string);
      return runAsTool({
        toolName: "pacx_auth_create", binary: "pacx", args,
        timeoutMs: 600_000, // OAuth interactive can wait
        redact: client_secret ? [client_secret, ...(connection_string ? [connection_string] : [])] : connection_string ? [connection_string] : [],
      });
    }
  );

  server.tool(
    "pacx_auth_select",
    "Select a PACX auth profile as active for subsequent pacx commands.",
    {
      name: z.string().describe("Profile name from pacx_auth_list"),
    },
    async ({ name }) => runAsTool({
      toolName: "pacx_auth_select", binary: "pacx",
      args: ["auth", "select", "--name", name], timeoutMs: 15_000,
    })
  );

  server.tool(
    "pacx_auth_delete",
    "DESTRUCTIVE: delete a PACX auth profile from local store. Does not affect underlying SP or user account.",
    {
      name: z.string(),
      confirm: z.boolean(),
    },
    async ({ name, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pass confirm=true to delete the PACX profile." }] };
      return runAsTool({
        toolName: "pacx_auth_delete", binary: "pacx",
        args: ["auth", "delete", "--name", name], timeoutMs: 15_000,
      });
    }
  );

  server.tool(
    "pacx_auth_rename",
    "Rename a PACX auth profile.",
    {
      old_name: z.string(),
      new_name: z.string().max(30),
    },
    async ({ old_name, new_name }) => runAsTool({
      toolName: "pacx_auth_rename", binary: "pacx",
      args: ["auth", "rename", "--old", old_name, "--new", new_name], timeoutMs: 15_000,
    })
  );

  server.tool(
    "pacx_auth_ping",
    "Test the PACX connection to the currently selected Dataverse environment. Useful sanity check before bulk operations.",
    {},
    async () => runAsTool({
      toolName: "pacx_auth_ping", binary: "pacx",
      args: ["auth", "ping"], timeoutMs: 60_000,
    })
  );
}
