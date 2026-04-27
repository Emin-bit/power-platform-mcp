import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";

const ModelVersion = z.enum(["Standard", "Enhanced"]);

export function registerPages(server: McpServer) {
  server.tool(
    "pages_list",
    "List Power Pages websites in the active (or specified) Dataverse environment.",
    {
      environment: z.string().optional(),
      verbose: z.boolean().default(false),
    },
    async ({ environment, verbose }) => {
      const args = ["pages", "list"];
      if (environment) args.push("--environment", environment);
      if (verbose) args.push("--verbose", "true");
      return runAsTool({ toolName: "pages_list", binary: "pac", args, timeoutMs: 60_000 });
    }
  );

  server.tool(
    "pages_download",
    "Download Power Pages website content from the active env to local disk. Does NOT modify the environment.",
    {
      path: z.string().describe("Local path to download to"),
      website_id: z.string().describe("Power Pages website ID"),
      include_entities: z.string().optional().describe("Comma-separated entity logical names to include (only)"),
      exclude_entities: z.string().optional().describe("Comma-separated entity logical names to exclude"),
      overwrite: z.boolean().default(false),
      model_version: ModelVersion.optional(),
      environment: z.string().optional(),
    },
    async ({ path, website_id, include_entities, exclude_entities, overwrite, model_version, environment }) => {
      const args = ["pages", "download", "--path", path, "--webSiteId", website_id];
      if (include_entities) args.push("--includeEntities", include_entities);
      if (exclude_entities) args.push("--excludeEntities", exclude_entities);
      if (overwrite) args.push("--overwrite", "true");
      if (model_version) args.push("--modelVersion", model_version);
      if (environment) args.push("--environment", environment);
      return runAsTool({ toolName: "pages_download", binary: "pac", args, timeoutMs: 30 * 60_000 });
    }
  );

  server.tool(
    "pages_upload",
    "Upload Power Pages website content from local disk to the active env. DESTRUCTIVE: overwrites the live site content. Requires confirm=true.",
    {
      path: z.string().describe("Local path to upload from"),
      deployment_profile: z.string().optional().describe("Deployment profile name (default: 'default')"),
      force_upload_all: z.boolean().default(false).describe("Upload everything regardless of changes"),
      model_version: ModelVersion.optional(),
      environment: z.string().optional(),
      confirm: z.boolean().describe("Must be true (destructive)"),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pages_upload overwrites the live Power Pages site. Re-call with confirm=true." }] };
      const args = ["pages", "upload", "--path", a.path];
      if (a.deployment_profile) args.push("--deploymentProfile", a.deployment_profile);
      if (a.force_upload_all) args.push("--forceUploadAll", "true");
      if (a.model_version) args.push("--modelVersion", a.model_version);
      if (a.environment) args.push("--environment", a.environment);
      return runAsTool({ toolName: "pages_upload", binary: "pac", args, timeoutMs: 30 * 60_000 });
    }
  );

  server.tool(
    "pages_clone",
    "Create local Power Pages website content based on existing local content. Local-only operation.",
    {
      path: z.string().describe("Path of source website content"),
      output_directory: z.string().describe("Output directory for the cloned content"),
      name: z.string().optional().describe("Optional new site name (default: 'Copy of <original>')"),
      overwrite: z.boolean().default(false),
    },
    async ({ path, output_directory, name, overwrite }) => {
      const args = ["pages", "clone", "--path", path, "--outputDirectory", output_directory];
      if (name) args.push("--name", name);
      if (overwrite) args.push("--overwrite", "true");
      return runAsTool({ toolName: "pages_clone", binary: "pac", args, timeoutMs: 5 * 60_000 });
    }
  );
}
