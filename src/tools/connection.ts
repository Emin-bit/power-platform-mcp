import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";

export function registerConnection(server: McpServer) {
  server.tool(
    "connection_list",
    "List all Dataverse connections in the active (or specified) env.",
    {
      environment: z.string().optional(),
    },
    async ({ environment }) => {
      const args = ["connection", "list"];
      if (environment) args.push("--environment", environment);
      return runAsTool({ toolName: "connection_list", binary: "pac", args, timeoutMs: 60_000 });
    }
  );

  server.tool(
    "connection_create",
    "Create a new Dataverse connection bound to a Service Principal. The client_secret is forwarded directly to PAC and never logged.",
    {
      name: z.string().describe("Connection display name"),
      tenant_id: z.string().describe("Entra tenant ID (GUID)"),
      application_id: z.string().describe("SP Application (client) ID"),
      client_secret: z.string().describe("SP client secret"),
      environment: z.string().optional(),
    },
    async ({ name, tenant_id, application_id, client_secret, environment }) => {
      const args = [
        "connection", "create",
        "--name", name,
        "--tenant-id", tenant_id,
        "--application-id", application_id,
        "--client-secret", client_secret,
      ];
      if (environment) args.push("--environment", environment);
      return runAsTool({
        toolName: "connection_create", binary: "pac", args,
        timeoutMs: 60_000,
        redact: [client_secret],
      });
    }
  );

  server.tool(
    "connection_update",
    "Update an existing Dataverse connection (rotate SP credentials).",
    {
      connection_id: z.string().describe("Connection ID to update"),
      tenant_id: z.string(),
      application_id: z.string(),
      client_secret: z.string(),
      environment: z.string().optional(),
    },
    async ({ connection_id, tenant_id, application_id, client_secret, environment }) => {
      const args = [
        "connection", "update",
        "--connection-id", connection_id,
        "--tenant-id", tenant_id,
        "--application-id", application_id,
        "--client-secret", client_secret,
      ];
      if (environment) args.push("--environment", environment);
      return runAsTool({
        toolName: "connection_update", binary: "pac", args,
        timeoutMs: 60_000,
        redact: [client_secret],
      });
    }
  );

  server.tool(
    "connection_delete",
    "DESTRUCTIVE: delete a Dataverse connection by id. Requires confirm=true.",
    {
      connection_id: z.string(),
      environment: z.string().optional(),
      confirm: z.boolean(),
    },
    async ({ connection_id, environment, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: connection_delete is destructive. Re-call with confirm=true." }] };
      const args = ["connection", "delete", "--connection-id", connection_id];
      if (environment) args.push("--environment", environment);
      return runAsTool({ toolName: "connection_delete", binary: "pac", args, timeoutMs: 60_000 });
    }
  );
}
