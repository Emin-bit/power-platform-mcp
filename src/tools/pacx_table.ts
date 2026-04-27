import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { backgroundResult } from "../jobs.js";

const bg = (name: string, args: string[]) => backgroundResult(name, "pacx", args);

const Ownership = z.enum([
  "None", "UserOwned", "TeamOwned", "BusinessOwned",
  "OrganizationOwned", "BusinessParented", "Filtered",
]);
const RequiredLevel = z.enum(["None", "SystemRequired", "ApplicationRequired", "Recommended"]);
const ExportWhat = z.enum(["Entity", "Default", "Attributes", "Privileges", "Relationships", "All"]);
const ExportFormat = z.enum(["Json", "Excel"]);

export function registerPacxTable(server: McpServer) {
  server.tool(
    "pacx_table_create",
    "USE THIS to create a new Dataverse table. ⚠️ PAC has NO direct table-create equivalent — pac_run with 'table create' will fail. This is the primary tool for table creation. " +
    "Defaults to UserOwned ownership and audit enabled. Pre-requisite: pacx_auth_select must have set the target environment (PACX has its own auth store, separate from PAC). " +
    "Often exceeds 60s on Dataverse — set background=true to fire-and-forget (returns job id, bypasses Claude Desktop MCP transport timeout). Track via job_status/job_wait.",
    {
      name: z.string().describe("Table display name (singular)"),
      plural: z.string().optional().describe("Collection name (auto-derived if omitted)"),
      schema_name: z.string().optional().describe("Technical schema name (auto-derived from display name)"),
      description: z.string().optional(),
      ownership: Ownership.default("UserOwned"),
      // Primary attribute
      primary_attribute_name: z.string().optional().describe("Primary attribute display name (default: 'Name', or 'Code' if autonumber)"),
      primary_attribute_schema_name: z.string().optional(),
      primary_attribute_description: z.string().optional(),
      primary_attribute_autonumber_format: z.string().optional().describe("If set, makes primary an autonumber"),
      primary_attribute_required_level: RequiredLevel.optional(),
      primary_attribute_max_length: z.number().int().positive().optional(),
      // Capabilities
      is_activity: z.boolean().default(false),
      offline: z.boolean().default(false),
      queue: z.boolean().default(false),
      feedback: z.boolean().default(false),
      notes: z.boolean().default(false),
      audit: z.boolean().default(true),
      connection: z.boolean().default(false),
      change_tracking: z.boolean().default(false),
      quick_create: z.boolean().default(false),
      has_email: z.boolean().default(false),
      solution: z.string().optional().describe("Solution unique name (default: PACX default solution)"),
      background: z.boolean().default(false).describe("Fire-and-forget; returns job id, bypasses MCP transport timeout"),
    },
    async (a) => {
      const args = ["table", "create", "--name", a.name];
      if (a.plural) args.push("--plural", a.plural);
      if (a.schema_name) args.push("--schemaName", a.schema_name);
      if (a.description) args.push("--description", a.description);
      args.push("--ownership", a.ownership);
      if (a.primary_attribute_name) args.push("--primaryAttributeName", a.primary_attribute_name);
      if (a.primary_attribute_schema_name) args.push("--primaryAttributeSchemaName", a.primary_attribute_schema_name);
      if (a.primary_attribute_description) args.push("--primaryAttributeDescription", a.primary_attribute_description);
      if (a.primary_attribute_autonumber_format) args.push("--primaryAttributeAutoNumberFormat", a.primary_attribute_autonumber_format);
      if (a.primary_attribute_required_level) args.push("--primaryAttributeRequiredLevel", a.primary_attribute_required_level);
      if (a.primary_attribute_max_length !== undefined) args.push("--primaryAttributeMaxLength", String(a.primary_attribute_max_length));
      if (a.is_activity) args.push("--isActivity", "true");
      if (a.offline) args.push("--offline", "true");
      if (a.queue) args.push("--queue", "true");
      if (a.feedback) args.push("--feedback", "true");
      if (a.notes) args.push("--notes", "true");
      if (!a.audit) args.push("--audit", "false");
      if (a.connection) args.push("--connection", "true");
      if (a.change_tracking) args.push("--changeTracking", "true");
      if (a.quick_create) args.push("--quickCreate", "true");
      if (a.has_email) args.push("--hasEmail", "true");
      if (a.solution) args.push("--solution", a.solution);
      if (a.background) return bg("pacx_table_create", args);
      return runAsTool({
        toolName: "pacx_table_create", binary: "pacx", args,
        timeoutMs: 5 * 60_000,
        hint: "After creating, use pacx_column_add to add columns, then pacx_publish_all to publish.",
      });
    }
  );

  server.tool(
    "pacx_table_update",
    "USE THIS to update Dataverse table metadata (rename, toggle audit/feedback/notes/email/quick-create/change-tracking). ⚠️ PAC has NO direct table-update equivalent. Set background=true to bypass MCP transport timeout.",
    {
      schema_name: z.string().describe("Schema name of the table to update"),
      name: z.string().describe("New display name"),
      plural: z.string().optional(),
      feedback: z.boolean().default(false).describe("Enable feedback (set-only)"),
      notes: z.boolean().default(false).describe("Enable notes (set-only)"),
      audit: z.boolean().default(true),
      change_tracking: z.boolean().optional(),
      quick_create: z.boolean().default(false),
      has_email: z.boolean().default(false).describe("Enable email column (set-only)"),
      background: z.boolean().default(false),
    },
    async (a) => {
      const args = ["table", "update", "--schemaName", a.schema_name, "--name", a.name];
      if (a.plural) args.push("--plural", a.plural);
      if (a.feedback) args.push("--feedback", "true");
      if (a.notes) args.push("--notes", "true");
      if (!a.audit) args.push("--audit", "false");
      if (a.change_tracking !== undefined) args.push("--changeTracking", String(a.change_tracking));
      if (a.quick_create) args.push("--quickCreate", "true");
      if (a.has_email) args.push("--hasEmail", "true");
      if (a.background) return bg("pacx_table_update", args);
      return runAsTool({ toolName: "pacx_table_update", binary: "pacx", args, timeoutMs: 5 * 60_000 });
    }
  );

  server.tool(
    "pacx_table_delete",
    "USE THIS to delete a Dataverse table. ⚠️ PAC has NO direct table-delete equivalent. DESTRUCTIVE — requires confirm=true. Set background=true if delete may exceed 60s.",
    {
      name: z.string().describe("Schema name of the table to delete"),
      confirm: z.boolean(),
      background: z.boolean().default(false),
    },
    async ({ name, confirm, background }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pacx_table_delete deletes the table and all its data. Re-call with confirm=true." }] };
      const args = ["table", "delete", "--name", name];
      if (background) return bg("pacx_table_delete", args);
      return runAsTool({
        toolName: "pacx_table_delete", binary: "pacx", args,
        timeoutMs: 10 * 60_000,
      });
    }
  );

  server.tool(
    "pacx_table_print",
    "Generate a Mermaid classDiagram representation of tables in a solution. Useful for documentation. Read-only.",
    {
      solution: z.string().optional().describe("Solution name (default: PACX default solution)"),
      include_security_tables: z.boolean().default(false),
      skip_missing_tables: z.boolean().default(false),
    },
    async ({ solution, include_security_tables, skip_missing_tables }) => {
      const args = ["table", "print"];
      if (solution) args.push("--solution", solution);
      if (include_security_tables) args.push("--include-security-tables", "true");
      if (skip_missing_tables) args.push("--skip-missing-tables", "true");
      return runAsTool({ toolName: "pacx_table_print", binary: "pacx", args, timeoutMs: 2 * 60_000 });
    }
  );

  server.tool(
    "pacx_table_export_metadata",
    "Export table metadata definition (entity, attributes, privileges, relationships) for documentation. Read-only — writes to local disk.",
    {
      table: z.string().describe("Schema name of the table"),
      what: ExportWhat.default("All"),
      output: z.string().optional().describe("Output folder (default: cwd)"),
      format: ExportFormat.default("Json"),
      run: z.boolean().default(false).describe("Open the file after export"),
    },
    async ({ table, what, output, format, run }) => {
      const args = ["table", "exportMetadata", "--table", table, "--what", what, "--format", format];
      if (output) args.push("--output", output);
      if (run) args.push("--run", "true");
      return runAsTool({ toolName: "pacx_table_export_metadata", binary: "pacx", args, timeoutMs: 5 * 60_000 });
    }
  );
}
