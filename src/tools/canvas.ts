import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool } from "../runner.js";

export function registerCanvas(server: McpServer) {
  server.tool(
    "canvas_list",
    "List canvas apps in the active (or specified) Dataverse environment.",
    {
      environment: z.string().optional(),
    },
    async ({ environment }) => {
      const args = ["canvas", "list"];
      if (environment) args.push("--environment", environment);
      return runAsTool({ toolName: "canvas_list", binary: "pac", args, timeoutMs: 60_000 });
    }
  );

  server.tool(
    "canvas_download",
    "Download a canvas app as a .msapp file. Read-only operation against the env.",
    {
      name: z.string().describe("Canvas app exact name, partial name, or App ID"),
      file_name: z.string().optional().describe("Output filename (default: <appname>.msapp in cwd)"),
      extract_to_directory: z.string().optional().describe("Directory to extract the .msapp into instead of saving the zip"),
      overwrite: z.boolean().default(false).describe("Allow overwriting existing file"),
      environment: z.string().optional(),
    },
    async ({ name, file_name, extract_to_directory, overwrite, environment }) => {
      const args = ["canvas", "download", "--name", name];
      if (file_name) args.push("--file-name", file_name);
      if (extract_to_directory) args.push("--extract-to-directory", extract_to_directory);
      if (overwrite) args.push("--overwrite", "true");
      if (environment) args.push("--environment", environment);
      return runAsTool({ toolName: "canvas_download", binary: "pac", args, timeoutMs: 5 * 60_000 });
    }
  );

  server.tool(
    "canvas_pack",
    "(Preview) Pack canvas app sources into a .msapp file. Local-only operation.",
    {
      sources: z.string().describe("Directory with sources to be packed"),
      msapp: z.string().describe("Output .msapp file path"),
    },
    async ({ sources, msapp }) => runAsTool({
      toolName: "canvas_pack", binary: "pac",
      args: ["canvas", "pack", "--sources", sources, "--msapp", msapp],
      timeoutMs: 5 * 60_000,
    })
  );

  server.tool(
    "canvas_unpack",
    "(Preview) Extract a .msapp file into a sources directory. Local-only operation.",
    {
      msapp: z.string().describe(".msapp file path to unpack"),
      sources: z.string().optional().describe("Output sources directory (default derived from msapp name)"),
    },
    async ({ msapp, sources }) => {
      const args = ["canvas", "unpack", "--msapp", msapp];
      if (sources) args.push("--sources", sources);
      return runAsTool({ toolName: "canvas_unpack", binary: "pac", args, timeoutMs: 5 * 60_000 });
    }
  );

  server.tool(
    "canvas_create",
    "Generate a canvas app from a custom connector. Pass either connector_id or connector_display_name.",
    {
      msapp: z.string().describe("Output .msapp path"),
      connector_id: z.string().optional(),
      connector_display_name: z.string().optional(),
      environment: z.string().optional(),
    },
    async ({ msapp, connector_id, connector_display_name, environment }) => {
      if (!connector_id && !connector_display_name) {
        return { isError: true, content: [{ type: "text", text: "Pass connector_id or connector_display_name." }] };
      }
      const args = ["canvas", "create", "--msapp", msapp];
      if (connector_id) args.push("--connector-id", connector_id);
      if (connector_display_name) args.push("--connector-display-name", connector_display_name);
      if (environment) args.push("--environment", environment);
      return runAsTool({ toolName: "canvas_create", binary: "pac", args, timeoutMs: 5 * 60_000 });
    }
  );
}
