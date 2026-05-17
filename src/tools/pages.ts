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

  // ============================================================================
  // Phase H (v1.3.0) — the 4 pac pages subcommands that were missing.
  // 30-day production analysis (beanstandung.powerappsportals.com) flagged that
  // only 4/8 pac pages commands were exposed, and the Enhanced data model
  // (code-site) commands were the most painful gap because Microsoft is steering
  // all new Power Pages development toward the Enhanced model.
  // ============================================================================

  server.tool(
    "pages_download_code_site",
    "Download an ENHANCED data model Power Pages site (the VS Code / code-first format) from the active env " +
    "to local disk. This is the modern Power Pages dev format Microsoft recommends for new projects — " +
    "distinct from pages_download which handles the Standard data model. Read-only against the env.",
    {
      path: z.string().describe("Local path to download the code site into"),
      website_id: z.string().describe("Power Pages website ID (from pages_list)"),
      overwrite: z.boolean().default(false),
      environment: z.string().optional().describe("Target env URL/Guid; defaults to active"),
    },
    async ({ path, website_id, overwrite, environment }) => {
      const args = ["pages", "download-code-site", "--path", path, "--webSiteId", website_id];
      if (overwrite) args.push("--overwrite", "true");
      if (environment) args.push("--environment", environment);
      return runAsTool({ toolName: "pages_download_code_site", binary: "pac", args, timeoutMs: 30 * 60_000 });
    }
  );

  server.tool(
    "pages_upload_code_site",
    "Upload a compiled ENHANCED data model Power Pages site to the env. DESTRUCTIVE: overwrites the live " +
    "code site. The Enhanced-model counterpart of pages_upload. " +
    "Reminder: after upload the server-side cache must be cleared for changes to appear — call " +
    "pages_restart (the reliable programmatic cache-clear) afterward.",
    {
      root_path: z.string().describe("Root source folder of the Power Pages code project (--rootPath)"),
      compiled_path: z.string().optional().describe("Location of the compiled code output (--compiledPath)"),
      site_name: z.string().optional().describe("Name of the site (--siteName)"),
      confirm: z.boolean().describe("Must be true (destructive — overwrites the live code site)"),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) {
        return { isError: true, content: [{ type: "text", text: "BLOCKED: pages_upload_code_site overwrites the live Enhanced-model site. Re-call with confirm=true. After it succeeds, run pages_restart to clear server-side cache." }] };
      }
      const args = ["pages", "upload-code-site", "--rootPath", a.root_path];
      if (a.compiled_path) args.push("--compiledPath", a.compiled_path);
      if (a.site_name) args.push("--siteName", a.site_name);
      return runAsTool({
        toolName: "pages_upload_code_site", binary: "pac", args, timeoutMs: 30 * 60_000,
        hint: "Upload done. Server-side cache still holds the OLD content — call pages_restart to flush it (the reliable programmatic alternative to the Design Studio Sync button).",
      });
    }
  );

  server.tool(
    "pages_migrate_datamodel",
    "Manage Standard → Enhanced data model migration for a Power Pages site (or check status / revert / reset). " +
    "DESTRUCTIVE when actually migrating or reverting — alters the site's data model. Use check_status first.",
    {
      website_id: z.string().describe("Power Pages website ID"),
      mode: z.enum(["configurationData", "configurationDataRefrences", "all"]).optional().describe(
        "Migration scope. Note Microsoft's CLI spells the middle value 'configurationDataRefrences' (sic).",
      ),
      report_path: z.string().optional().describe("Local path to store the site customization report (--siteCustomizationReportPath)"),
      check_status: z.boolean().default(false).describe("Only check migration status (non-destructive, no confirm needed)"),
      update_data_model_version: z.boolean().default(false).describe("Stamp the new data-model version after a successful data migration"),
      revert_to_standard: z.boolean().default(false).describe("DESTRUCTIVE: revert the site from Enhanced back to Standard"),
      reset_migration: z.boolean().default(false).describe("DESTRUCTIVE: reset the in-progress migration"),
      portal_id: z.string().optional().describe("Portal ID for the website under migration"),
      environment: z.string().optional(),
      confirm: z.boolean().default(false).describe("Required true for any mutating mode (migrate/revert/reset/update-version). Not needed for check_status."),
    },
    async (a): Promise<ToolResult> => {
      const mutating = a.revert_to_standard || a.reset_migration || a.update_data_model_version || (!a.check_status && !!a.mode);
      if (mutating && !a.confirm) {
        return { isError: true, content: [{ type: "text", text: "BLOCKED: pages_migrate_datamodel is changing the site data model (migrate/revert/reset/update-version). Re-call with confirm=true. Run with check_status:true first to see current state." }] };
      }
      const args = ["pages", "migrate-datamodel", "--webSiteId", a.website_id];
      if (a.mode) args.push("--mode", a.mode);
      if (a.report_path) args.push("--siteCustomizationReportPath", a.report_path);
      if (a.check_status) args.push("--checkMigrationStatus", "true");
      if (a.update_data_model_version) args.push("--updateDataModelVersion", "true");
      if (a.revert_to_standard) args.push("--revertToStandardDataModel", "true");
      if (a.reset_migration) args.push("--resetMigration", "true");
      if (a.portal_id) args.push("--portalId", a.portal_id);
      if (a.environment) args.push("--environment", a.environment);
      return runAsTool({ toolName: "pages_migrate_datamodel", binary: "pac", args, timeoutMs: 30 * 60_000 });
    }
  );

  server.tool(
    "pages_bootstrap_migrate",
    "Migrate a Power Pages site's HTML from Bootstrap v3 to Bootstrap v5 (local content transformation). " +
    "Local-only — produces a migrated copy you then review + pages_upload. After uploading, clear cache via pages_restart.",
    {
      path: z.string().describe("Path of the website content to migrate (--path)"),
    },
    async ({ path }) => {
      const args = ["pages", "bootstrap-migrate", "--path", path];
      return runAsTool({
        toolName: "pages_bootstrap_migrate", binary: "pac", args, timeoutMs: 10 * 60_000,
        hint: "Bootstrap v3→v5 migration produced locally. Review the diff, then pages_upload (confirm:true) and pages_restart to clear cache.",
      });
    }
  );
}
