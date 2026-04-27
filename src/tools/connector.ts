import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool } from "../runner.js";

const ConnectionTemplate = z.enum(["NoAuth", "BasicAuth", "ApiKey", "OAuthGeneric", "OAuthAAD"]);

export function registerConnector(server: McpServer) {
  server.tool(
    "connector_list",
    "List all Power Platform connectors registered in the active (or specified) Dataverse env.",
    {
      environment: z.string().optional(),
    },
    async ({ environment }) => {
      const args = ["connector", "list"];
      if (environment) args.push("--environment", environment);
      return runAsTool({ toolName: "connector_list", binary: "pac", args, timeoutMs: 60_000 });
    }
  );

  server.tool(
    "connector_init",
    "Initialize a new connector API Properties file scaffold. Local-only.",
    {
      output_directory: z.string().describe("Output directory"),
      connection_template: ConnectionTemplate.optional().describe("Auth template for the connector"),
      generate_script_file: z.boolean().default(false),
      generate_settings_file: z.boolean().default(false),
    },
    async ({ output_directory, connection_template, generate_script_file, generate_settings_file }) => {
      const args = ["connector", "init", "--outputDirectory", output_directory];
      if (connection_template) args.push("--connection-template", connection_template);
      if (generate_script_file) args.push("--generate-script-file", "true");
      if (generate_settings_file) args.push("--generate-settings-file", "true");
      return runAsTool({ toolName: "connector_init", binary: "pac", args, timeoutMs: 60_000 });
    }
  );

  server.tool(
    "connector_create",
    "Create a new connector row in the Connector table in Dataverse from local files (OpenAPI definition + API properties). Modifies the env.",
    {
      api_definition_file: z.string().optional().describe("Path to OpenAPI definition .json"),
      api_properties_file: z.string().optional().describe("Path to API Properties .json"),
      icon_file: z.string().optional().describe("Path to Icon .png"),
      script_file: z.string().optional().describe("Path to .csx script"),
      solution_unique_name: z.string().optional().describe("Solution to add the connector to"),
      settings_file: z.string().optional(),
      environment: z.string().optional(),
    },
    async ({ api_definition_file, api_properties_file, icon_file, script_file, solution_unique_name, settings_file, environment }) => {
      const args = ["connector", "create"];
      if (api_definition_file) args.push("--api-definition-file", api_definition_file);
      if (api_properties_file) args.push("--api-properties-file", api_properties_file);
      if (icon_file) args.push("--icon-file", icon_file);
      if (script_file) args.push("--script-file", script_file);
      if (solution_unique_name) args.push("--solution-unique-name", solution_unique_name);
      if (settings_file) args.push("--settings-file", settings_file);
      if (environment) args.push("--environment", environment);
      return runAsTool({ toolName: "connector_create", binary: "pac", args, timeoutMs: 5 * 60_000 });
    }
  );

  server.tool(
    "connector_download",
    "Download a connector's OpenAPI definition and API Properties files from the env to local disk. Read-only.",
    {
      connector_id: z.string(),
      output_directory: z.string().optional(),
      environment: z.string().optional(),
    },
    async ({ connector_id, output_directory, environment }) => {
      const args = ["connector", "download", "--connector-id", connector_id];
      if (output_directory) args.push("--outputDirectory", output_directory);
      if (environment) args.push("--environment", environment);
      return runAsTool({ toolName: "connector_download", binary: "pac", args, timeoutMs: 60_000 });
    }
  );

  server.tool(
    "connector_update",
    "Update an existing connector row in the Connector table in Dataverse. Modifies the env.",
    {
      connector_id: z.string(),
      api_definition_file: z.string().optional(),
      api_properties_file: z.string().optional(),
      icon_file: z.string().optional(),
      script_file: z.string().optional(),
      solution_unique_name: z.string().optional(),
      settings_file: z.string().optional(),
      environment: z.string().optional(),
    },
    async ({ connector_id, api_definition_file, api_properties_file, icon_file, script_file, solution_unique_name, settings_file, environment }) => {
      const args = ["connector", "update", "--connector-id", connector_id];
      if (api_definition_file) args.push("--api-definition-file", api_definition_file);
      if (api_properties_file) args.push("--api-properties-file", api_properties_file);
      if (icon_file) args.push("--icon-file", icon_file);
      if (script_file) args.push("--script-file", script_file);
      if (solution_unique_name) args.push("--solution-unique-name", solution_unique_name);
      if (settings_file) args.push("--settings-file", settings_file);
      if (environment) args.push("--environment", environment);
      return runAsTool({ toolName: "connector_update", binary: "pac", args, timeoutMs: 5 * 60_000 });
    }
  );
}
