import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";

export function registerPcf(server: McpServer) {
  server.tool(
    "pcf_init",
    "Initialize a new Power Apps Component Framework (PCF) project in a directory. Local-only.",
    {
      namespace: z.string().describe("Component namespace (e.g. 'MyCompany')"),
      name: z.string().describe("Component name"),
      template: z.enum(["field", "dataset"]).describe("Component type"),
      framework: z.enum(["none", "react"]).default("none").describe("Rendering framework (default: HTML)"),
      output_directory: z.string().optional().describe("Output dir (default: cwd). NOTE: pac pcf init crashes if cwd is unwritable; pass an explicit output_directory to be safe."),
      run_npm_install: z.boolean().default(false),
    },
    async ({ namespace, name, template, framework, output_directory, run_npm_install }) => {
      const args = [
        "pcf", "init",
        "--namespace", namespace,
        "--name", name,
        "--template", template,
        "--framework", framework,
      ];
      if (output_directory) args.push("--outputDirectory", output_directory);
      if (run_npm_install) args.push("--run-npm-install", "true");
      return runAsTool({ toolName: "pcf_init", binary: "pac", args, timeoutMs: 10 * 60_000 });
    }
  );

  server.tool(
    "pcf_push",
    "Build and push a PCF project into the active env. DESTRUCTIVE: overwrites the existing component if it exists. Requires confirm=true.",
    {
      publisher_prefix: z.string().optional().describe("Customization prefix (e.g. 'mycorp')"),
      solution_unique_name: z.string().optional().describe("Solution to add the component to"),
      verbosity: z.enum(["minimal", "normal", "detailed", "diagnostic"]).optional(),
      interactive: z.boolean().default(false),
      incremental: z.boolean().default(false),
      force_import: z.boolean().default(false).describe("Force overwrite of existing component"),
      environment: z.string().optional(),
      confirm: z.boolean().describe("Must be true (modifies env)"),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pcf_push modifies the environment. Re-call with confirm=true after whoami." }] };
      const args = ["pcf", "push"];
      if (a.publisher_prefix) args.push("--publisher-prefix", a.publisher_prefix);
      if (a.solution_unique_name) args.push("--solution-unique-name", a.solution_unique_name);
      if (a.verbosity) args.push("--verbosity", a.verbosity);
      if (a.interactive) args.push("--interactive", "true");
      if (a.incremental) args.push("--incremental", "true");
      if (a.force_import) args.push("--force-import", "true");
      if (a.environment) args.push("--environment", a.environment);
      return runAsTool({ toolName: "pcf_push", binary: "pac", args, timeoutMs: 30 * 60_000 });
    }
  );

  server.tool(
    "pcf_version",
    "Bump patch version in PCF ControlManifest.xml file(s). Local-only.",
    {
      strategy: z.enum(["None", "GitTags", "FileTracking", "Manifest"]).optional(),
      patch_version: z.string().optional().describe("Explicit patch version to set"),
      path: z.string().optional().describe("Path to ControlManifest.xml"),
      all_manifests: z.boolean().default(false).describe("Update all manifests recursively"),
      filename: z.string().optional().describe("Tracker file when strategy=FileTracking"),
    },
    async ({ strategy, patch_version, path, all_manifests, filename }) => {
      const args = ["pcf", "version"];
      if (strategy) args.push("--strategy", strategy);
      if (patch_version) args.push("--patchversion", patch_version);
      if (path) args.push("--path", path);
      if (all_manifests) args.push("--allmanifests", "true");
      if (filename) args.push("--filename", filename);
      return runAsTool({ toolName: "pcf_version", binary: "pac", args, timeoutMs: 30_000 });
    }
  );
}
