import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";

export function registerPlugin(server: McpServer) {
  server.tool(
    "plugin_init",
    "Initialize a new Dataverse plug-in class library in a directory. Local-only.",
    {
      output_directory: z.string().describe("Output directory for the plugin project"),
      author: z.string().optional().describe("Author name(s)"),
      signing_key_file_path: z.string().optional().describe("Relative path to .snk file for strong-name signing"),
      skip_signing: z.boolean().default(false).describe("Skip strong-name signing (default: sign)"),
    },
    async ({ output_directory, author, signing_key_file_path, skip_signing }) => {
      const args = ["plugin", "init", "--outputDirectory", output_directory];
      if (author) args.push("--author", author);
      if (signing_key_file_path) args.push("--signing-key-file-path", signing_key_file_path);
      if (skip_signing) args.push("--skip-signing", "true");
      return runAsTool({ toolName: "plugin_init", binary: "pac", args, timeoutMs: 60_000 });
    }
  );

  server.tool(
    "plugin_push",
    "Push a plug-in assembly or NuGet package into the active env. DESTRUCTIVE: overwrites the existing assembly. Requires confirm=true.",
    {
      plugin_id: z.string().describe("ID of the plug-in assembly or package"),
      plugin_file: z.string().optional().describe("Path to the .dll (Assembly) or .nupkg (Nuget) file"),
      type: z.enum(["Nuget", "Assembly"]).default("Nuget"),
      configuration: z.string().optional().describe("Build configuration (e.g. Debug, Release)"),
      environment: z.string().optional(),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: plugin_push overwrites assembly in the env. Re-call with confirm=true after whoami." }] };
      const args = ["plugin", "push", "--pluginId", a.plugin_id, "--type", a.type];
      if (a.plugin_file) args.push("--pluginFile", a.plugin_file);
      if (a.configuration) args.push("--configuration", a.configuration);
      if (a.environment) args.push("--environment", a.environment);
      return runAsTool({ toolName: "plugin_push", binary: "pac", args, timeoutMs: 10 * 60_000 });
    }
  );
}
