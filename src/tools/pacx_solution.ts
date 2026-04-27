import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { backgroundResult } from "../jobs.js";

const bg = (name: string, args: string[]) => backgroundResult(name, "pacx", args);

export function registerPacxSolution(server: McpServer) {
  server.tool(
    "pacx_solution_list",
    "List solutions in the active PACX environment. Supports filtering by type, hidden inclusion, format, and ordering.",
    {
      type: z.string().optional().describe("Filter by solution type (e.g. 'Managed', 'Unmanaged')"),
      hidden: z.boolean().default(false).describe("Include hidden/system solutions"),
      format: z.string().optional().describe("Output format (text/csv depending on PACX version)"),
      orderby: z.string().optional().describe("Order by field (e.g. 'displayname', 'createdon')"),
    },
    async ({ type, hidden, format, orderby }) => {
      const args = ["solution", "list"];
      if (type) args.push("--type", type);
      if (hidden) args.push("--hidden", "true");
      if (format) args.push("--format", format);
      if (orderby) args.push("--orderby", orderby);
      return runAsTool({ toolName: "pacx_solution_list", binary: "pacx", args, timeoutMs: 60_000 });
    }
  );

  server.tool(
    "pacx_solution_create",
    "USE THIS to create a new unmanaged solution DIRECTLY in the Dataverse environment (with publisher). ⚠️ Different from pac solution_init which only scaffolds a LOCAL solution project — PAC has no equivalent that creates the solution record in the env itself. " +
    "Auto-derives unique name, prefix, and publisher names if you only pass --name.",
    {
      name: z.string().describe("Solution display name"),
      unique_name: z.string().optional().describe("Solution unique name (auto-derived if omitted)"),
      publisher_prefix: z.string().optional().describe("Customization prefix (auto-derived if omitted)"),
      publisher_unique_name: z.string().optional(),
      publisher_friendly_name: z.string().optional(),
      publisher_optionset_prefix: z.string().optional().describe("5-digit option set prefix"),
      application_ribbons: z.boolean().default(false).describe("Add application ribbons after create"),
      background: z.boolean().default(false).describe("Fire-and-forget; bypasses MCP transport timeout"),
    },
    async (a) => {
      const args = ["solution", "create", "--name", a.name];
      if (a.unique_name) args.push("--uniqueName", a.unique_name);
      if (a.publisher_prefix) args.push("--publisherPrefix", a.publisher_prefix);
      if (a.publisher_unique_name) args.push("--publisherUniqueName", a.publisher_unique_name);
      if (a.publisher_friendly_name) args.push("--publisherFriendlyName", a.publisher_friendly_name);
      if (a.publisher_optionset_prefix) args.push("--publisherOptionSetPrefix", a.publisher_optionset_prefix);
      if (a.application_ribbons) args.push("--applicationRibbons", "true");
      if (a.background) return bg("pacx_solution_create", args);
      return runAsTool({ toolName: "pacx_solution_create", binary: "pacx", args, timeoutMs: 5 * 60_000 });
    }
  );

  server.tool(
    "pacx_solution_delete",
    "DESTRUCTIVE: delete an unmanaged solution from the active PACX environment.",
    {
      unique_name: z.string(),
      confirm: z.boolean(),
      background: z.boolean().default(false),
    },
    async ({ unique_name, confirm, background }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pacx_solution_delete is destructive. Re-call with confirm=true after pacx_auth_ping." }] };
      const args = ["solution", "delete", "--uniqueName", unique_name];
      if (background) return bg("pacx_solution_delete", args);
      return runAsTool({
        toolName: "pacx_solution_delete", binary: "pacx", args,
        timeoutMs: 5 * 60_000,
      });
    }
  );

  server.tool(
    "pacx_solution_get_default",
    "Get the default solution for the active PACX environment (if previously set via pacx_solution_set_default). PACX uses a 'default solution' concept that PAC does not — many pacx commands target this implicitly.",
    {},
    async () => runAsTool({
      toolName: "pacx_solution_get_default", binary: "pacx",
      args: ["solution", "getDefault"], timeoutMs: 30_000,
    })
  );

  server.tool(
    "pacx_solution_set_default",
    "Set the default solution for the active PACX environment. Many subsequent pacx commands (table create, column add, etc.) will default to this solution.",
    {
      name: z.string().describe("Solution unique name"),
    },
    async ({ name }) => runAsTool({
      toolName: "pacx_solution_set_default", binary: "pacx",
      args: ["solution", "setDefault", "--name", name], timeoutMs: 30_000,
      hint: "Subsequent pacx_table_create / pacx_column_add will use this as default solution.",
    })
  );

  server.tool(
    "pacx_solution_get_publishers",
    "List publishers (unique name, friendly name, prefix) available in the active PACX environment.",
    {
      verbose: z.boolean().default(false),
    },
    async ({ verbose }) => {
      const args = ["solution", "getPublisherList"];
      if (verbose) args.push("--verbose", "true");
      return runAsTool({ toolName: "pacx_solution_get_publishers", binary: "pacx", args, timeoutMs: 60_000 });
    }
  );
}
