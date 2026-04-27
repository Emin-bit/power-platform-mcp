import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { backgroundResult } from "../jobs.js";

const bg = (name: string, args: string[]) => backgroundResult(name, "pacx", args);

const ColumnType = z.enum([
  "boolean", "datetime", "decimal", "double", "file", "image",
  "integer", "memo", "money", "optionset", "string",
]);
const RequiredLevel = z.enum(["None", "SystemRequired", "ApplicationRequired", "Recommended"]);

export function registerPacxColumn(server: McpServer) {
  server.tool(
    "pacx_column_add",
    "USE THIS to add a column (field) to a Dataverse table. ⚠️ PAC has NO direct column-add equivalent — pac_run with column ops will fail. This is the primary tool for adding fields. " +
    "The 'type' selects the underlying `pacx column add <type>` command. Common args (table, name, schema_name, description, required_level, audit, solution) apply to all types. " +
    "Type-specific args (length for string, min/max for numbers, options for optionset, etc.) are passed conditionally — for niche flags not covered here, use pacx_run.",
    {
      type: ColumnType.describe("Column data type"),
      table: z.string().describe("Table schema name"),
      name: z.string().describe("Column display name"),
      schema_name: z.string().optional().describe("Column schema name (auto-derived from display name)"),
      description: z.string().optional(),
      required_level: RequiredLevel.optional(),
      audit: z.boolean().optional(),
      solution: z.string().optional().describe("Unmanaged solution name (default: PACX default)"),

      // string-specific
      length: z.number().int().positive().optional().describe("Max length (string type only)"),
      string_format: z.enum(["Email", "Text", "TextArea", "Url", "TickerSymbol", "PhoneticGuide", "VersionNumber", "Phone", "Json", "RichText"]).optional(),
      auto_number_format: z.string().optional().describe("Autonumber format (string type only, e.g. 'PRE-{SEQNUM:5}')"),

      // number-specific (integer, decimal, double, money)
      min: z.number().optional(),
      max: z.number().optional(),
      precision: z.number().int().nonnegative().optional().describe("Decimal/money precision"),

      // integer-specific
      int_format: z.enum(["None", "Duration", "TimeZone", "Language", "Locale"]).optional(),

      // datetime-specific
      datetime_behavior: z.enum(["UserLocal", "TimeZoneIndependent", "DateOnly"]).optional(),
      datetime_format: z.enum(["DateOnly", "DateAndTime"]).optional(),

      // boolean-specific
      true_label: z.string().optional(),
      false_label: z.string().optional(),
      default_value: z.string().optional(),

      // optionset-specific
      options: z.string().optional().describe("Comma/semicolon separated; or 'label:value' pairs"),
      multiselect: z.boolean().optional(),
      global_optionset_name: z.string().optional(),

      // file/image-specific
      max_size_kb: z.number().int().positive().optional(),

      // memo-specific
      memo_format: z.enum(["Email", "Json", "RichText", "Text", "TextArea"]).optional(),

      background: z.boolean().default(false).describe("Fire-and-forget; bypasses MCP transport timeout"),
    },
    async (a) => {
      const args = ["column", "add", a.type, "--table", a.table, "--name", a.name];
      if (a.schema_name) args.push("--schemaName", a.schema_name);
      if (a.description) args.push("--description", a.description);
      if (a.required_level) args.push("--requiredLevel", a.required_level);
      if (a.audit !== undefined) args.push("--audit", String(a.audit));
      if (a.solution) args.push("--solution", a.solution);

      // type-specific (passed conditionally; PACX rejects unknown flags so we only push relevant ones)
      switch (a.type) {
        case "string":
          if (a.length !== undefined) args.push("--len", String(a.length));
          if (a.string_format) args.push("--format", a.string_format);
          if (a.auto_number_format) args.push("--autoNumber", a.auto_number_format);
          break;
        case "integer":
          if (a.min !== undefined) args.push("--min", String(a.min));
          if (a.max !== undefined) args.push("--max", String(a.max));
          if (a.int_format) args.push("--intFormat", a.int_format);
          break;
        case "decimal":
        case "double":
        case "money":
          if (a.min !== undefined) args.push("--min", String(a.min));
          if (a.max !== undefined) args.push("--max", String(a.max));
          if (a.precision !== undefined) args.push("--precision", String(a.precision));
          break;
        case "datetime":
          if (a.datetime_behavior) args.push("--dateTimeBehavior", a.datetime_behavior);
          if (a.datetime_format) args.push("--dateTimeFormat", a.datetime_format);
          break;
        case "boolean":
          if (a.true_label) args.push("--trueLabel", a.true_label);
          if (a.false_label) args.push("--falseLabel", a.false_label);
          if (a.default_value) args.push("--defaultValue", a.default_value);
          break;
        case "optionset":
          if (a.options) args.push("--options", a.options);
          if (a.multiselect) args.push("--multiselect", "true");
          if (a.global_optionset_name) args.push("--globalOptionSetName", a.global_optionset_name);
          if (a.default_value) args.push("--defaultValue", a.default_value);
          break;
        case "file":
        case "image":
          if (a.max_size_kb !== undefined) args.push("--maxSizeInKB", String(a.max_size_kb));
          break;
        case "memo":
          if (a.memo_format) args.push("--memoFormat", a.memo_format);
          if (a.length !== undefined) args.push("--len", String(a.length));
          break;
      }
      if (a.background) return bg("pacx_column_add", args);
      return runAsTool({
        toolName: "pacx_column_add", binary: "pacx", args, timeoutMs: 3 * 60_000,
        hint: "Run pacx_publish_all afterwards to make the column visible to users.",
      });
    }
  );

  server.tool(
    "pacx_column_delete",
    "USE THIS to delete a Dataverse column. ⚠️ PAC has NO direct column-delete equivalent. DESTRUCTIVE — requires confirm=true.",
    {
      table: z.string().describe("Table schema name"),
      schema_name: z.string().describe("Column schema name"),
      confirm: z.boolean(),
      background: z.boolean().default(false),
    },
    async ({ table, schema_name, confirm, background }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pacx_column_delete is destructive. Re-call with confirm=true." }] };
      const args = ["column", "delete", "--table", table, "--schemaName", schema_name, "--force"];
      if (background) return bg("pacx_column_delete", args);
      return runAsTool({
        toolName: "pacx_column_delete", binary: "pacx", args,
        timeoutMs: 3 * 60_000,
      });
    }
  );

  server.tool(
    "pacx_column_export_metadata",
    "Export a column's metadata for documentation. Read-only — writes to local disk.",
    {
      table: z.string().describe("Table schema name"),
      column: z.string().describe("Column schema name"),
      output: z.string().optional().describe("Output folder (default: cwd)"),
      run: z.boolean().default(false).describe("Open after export"),
    },
    async ({ table, column, output, run }) => {
      const args = ["column", "exportMetadata", "--table", table, "--column", column];
      if (output) args.push("--output", output);
      if (run) args.push("--run", "true");
      return runAsTool({ toolName: "pacx_column_export_metadata", binary: "pacx", args, timeoutMs: 60_000 });
    }
  );
}
