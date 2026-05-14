import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool } from "../runner.js";
import { backgroundResult } from "../jobs.js";

const bg = (name: string, args: string[]) => backgroundResult(name, "pac", args);

const PackageType = z.enum(["Managed", "Unmanaged", "Both"]);
const SolutionInclude = z.enum([
  "autonumbering",
  "calendar",
  "customization",
  "emailtracking",
  "externalapplications",
  "general",
  "isvconfig",
  "marketing",
  "outlooksynchronization",
  "relationshiproles",
  "sales",
]);

export function registerSolution(server: McpServer) {
  // ---------- read ----------

  server.tool(
    "solution_list",
    "List all solutions in the active (or specified) Dataverse environment. Returns text table of unique name, friendly name, version, managed/unmanaged.",
    {
      environment: z.string().optional().describe("Environment URL or ID; defaults to active"),
      include_system: z.boolean().default(false).describe("Include Microsoft system solutions"),
    },
    async ({ environment, include_system }) => {
      const args = ["solution", "list"];
      if (environment) args.push("--environment", environment);
      if (include_system) args.push("--includeSystemSolutions", "true");
      return runAsTool({
        toolName: "solution_list",
        binary: "pac",
        args,
        timeoutMs: 60_000,
      });
    }
  );

  server.tool(
    "solution_online_version",
    "Get the live version of a solution in the active environment. Pass solution_version to UPDATE the online version (modifies the env — non-destructive but be intentional).",
    {
      solution_unique_name: z.string().describe("Solution unique name (not display name)"),
      solution_version: z.string().optional().describe("If set, UPDATES the online version to this value (e.g. 1.0.0.5)"),
      environment: z.string().optional().describe("Environment URL or ID; defaults to active"),
    },
    async ({ solution_unique_name, solution_version, environment }) => {
      const args = ["solution", "online-version", "--solution-name", solution_unique_name];
      if (solution_version) args.push("--solution-version", solution_version);
      if (environment) args.push("--environment", environment);
      return runAsTool({
        toolName: "solution_online_version",
        binary: "pac",
        args,
        timeoutMs: 60_000,
      });
    }
  );

  // ---------- local source operations ----------

  server.tool(
    "solution_init",
    "Initialize a new Dataverse solution project in a local directory. Local-only — does not contact any environment.",
    {
      publisher_name: z.string().describe("Publisher unique name (no spaces, no special chars)"),
      publisher_prefix: z.string().describe("Customization prefix (2-8 lowercase letters, e.g. 'mycorp')"),
      output_directory: z.string().describe("Path where the solution project will be created"),
    },
    async ({ publisher_name, publisher_prefix, output_directory }) => runAsTool({
      toolName: "solution_init",
      binary: "pac",
      args: [
        "solution", "init",
        "--publisher-name", publisher_name,
        "--publisher-prefix", publisher_prefix,
        "--outputDirectory", output_directory,
      ],
      timeoutMs: 30_000,
    })
  );

  server.tool(
    "solution_pack",
    "Pack a solution source folder into a .zip file (SolutionPackager). Local-only operation — does not contact any environment. Set background=true if a large solution may exceed MCP transport timeout.",
    {
      zipfile: z.string().describe("Output .zip file path"),
      folder: z.string().describe("Source folder containing the unpacked solution"),
      package_type: PackageType.default("Unmanaged"),
      allow_delete: z.boolean().default(false).describe("Allow deletion of files at output path"),
      allow_write: z.boolean().default(true).describe("Allow writing to output path"),
      clobber: z.boolean().default(false).describe("Overwrite read-only files"),
      single_component: z.enum(["WebResource", "Plugin", "Workflow", "None"]).optional(),
      localize: z.boolean().default(false).describe("Merge .resx string resources back into solution XML"),
      error_level: z.enum(["Verbose", "Info", "Warning", "Error", "Off"]).optional(),
      background: z.boolean().default(false),
    },
    async ({ zipfile, folder, package_type, allow_delete, allow_write, clobber, single_component, localize, error_level, background }) => {
      const args = [
        "solution", "pack",
        "--zipfile", zipfile,
        "--folder", folder,
        "--packagetype", package_type,
        "--allowDelete", String(allow_delete),
        "--allowWrite", String(allow_write),
      ];
      if (clobber) args.push("--clobber", "true");
      if (single_component) args.push("--singleComponent", single_component);
      if (localize) args.push("--localize", "true");
      if (error_level) args.push("--errorlevel", error_level);
      if (background) return bg("solution_pack", args);
      return runAsTool({
        toolName: "solution_pack",
        binary: "pac",
        args,
        timeoutMs: 300_000,
      });
    }
  );

  server.tool(
    "solution_unpack",
    "Unpack a solution .zip into a source folder structure (SolutionPackager). Local-only operation. Set background=true for large solutions.",
    {
      zipfile: z.string().describe("Path to .zip file to unpack"),
      folder: z.string().describe("Output folder for the unpacked source"),
      package_type: PackageType.default("Unmanaged"),
      allow_delete: z.boolean().default(false).describe("Allow deletion of files in output folder"),
      allow_write: z.boolean().default(true).describe("Allow writing to output folder"),
      clobber: z.boolean().default(false).describe("Overwrite read-only files in output"),
      single_component: z.enum(["WebResource", "Plugin", "Workflow", "None"]).optional(),
      localize: z.boolean().default(false).describe("Extract string resources to .resx files"),
      error_level: z.enum(["Verbose", "Info", "Warning", "Error", "Off"]).optional(),
      background: z.boolean().default(false),
    },
    async ({ zipfile, folder, package_type, allow_delete, allow_write, clobber, single_component, localize, error_level, background }) => {
      const args = [
        "solution", "unpack",
        "--zipfile", zipfile,
        "--folder", folder,
        "--packagetype", package_type,
        "--allowDelete", String(allow_delete),
        "--allowWrite", String(allow_write),
      ];
      if (clobber) args.push("--clobber", "true");
      if (single_component) args.push("--singleComponent", single_component);
      if (localize) args.push("--localize", "true");
      if (error_level) args.push("--errorlevel", error_level);
      if (background) return bg("solution_unpack", args);
      return runAsTool({
        toolName: "solution_unpack",
        binary: "pac",
        args,
        timeoutMs: 300_000,
      });
    }
  );

  server.tool(
    "solution_version",
    "Update the build/revision version of a local solution.xml. Local-only — does not modify any environment. Use solution_online_version to update the version in Dataverse.",
    {
      solution_path: z.string().describe("Path to the solution folder, .cdsproj file, or Solution.xml"),
      build_version: z.string().optional().describe("Set build version (e.g. '5')"),
      revision_version: z.string().optional().describe("Set revision version"),
      strategy: z.enum(["None", "GitTags", "FileTracking", "Solution"]).optional().describe("Auto-versioning strategy"),
      filename: z.string().optional().describe("Tracker CSV file when using FileTracking strategy"),
    },
    async ({ solution_path, build_version, revision_version, strategy, filename }) => {
      const args = ["solution", "version", "--solutionPath", solution_path];
      if (build_version) args.push("--buildversion", build_version);
      if (revision_version) args.push("--revisionversion", revision_version);
      if (strategy) args.push("--strategy", strategy);
      if (filename) args.push("--filename", filename);
      return runAsTool({
        toolName: "solution_version",
        binary: "pac",
        args,
        timeoutMs: 30_000,
      });
    }
  );

  server.tool(
    "solution_create_settings",
    "Generate a deployment settings .json template (for connection references and environment variables) from a solution .zip or unpacked folder.",
    {
      solution_zip: z.string().optional().describe("Path to solution .zip (use this OR solution_folder)"),
      solution_folder: z.string().optional().describe("Path to unpacked solution folder (use this OR solution_zip)"),
      settings_file: z.string().describe("Output .json file path"),
    },
    async ({ solution_zip, solution_folder, settings_file }) => {
      if (!solution_zip && !solution_folder) {
        return { isError: true, content: [{ type: "text", text: "Pass either solution_zip or solution_folder." }] };
      }
      const args = ["solution", "create-settings", "--settings-file", settings_file];
      if (solution_zip) args.push("--solution-zip", solution_zip);
      if (solution_folder) args.push("--solution-folder", solution_folder);
      return runAsTool({
        toolName: "solution_create_settings",
        binary: "pac",
        args,
        timeoutMs: 60_000,
      });
    }
  );

  // ---------- environment-affecting (non-destructive) ----------

  server.tool(
    "solution_export",
    "Export a solution from the active (or specified) environment to a local .zip file. Long-running for large solutions. Does NOT modify the environment. " +
    "Phase E (1.2.0): `background` now DEFAULTS TO TRUE when `async_mode:true` (the default), because historic data shows solution_export p95 = 77s — past Claude Desktop's 60s MCP transport timeout. " +
    "Set background:false explicitly to force synchronous blocking behavior if needed.",
    {
      name: z.string().describe("Solution unique name to export"),
      path: z.string().describe("Output .zip path"),
      managed: z.boolean().default(false).describe("Export as managed (default unmanaged)"),
      include: z.array(SolutionInclude).optional().describe("Settings to include (e.g. ['general','customization'])"),
      async_mode: z.boolean().default(true).describe("Use PAC --async (server-side polling)"),
      max_async_wait_minutes: z.number().int().positive().max(60).default(30),
      overwrite: z.boolean().default(false).describe("Overwrite existing .zip at path"),
      environment: z.string().optional().describe("Environment URL or ID; defaults to active"),
      background: z.boolean().optional().describe(
        "Return job id immediately; track via job_* tools. " +
        "DEFAULT: true when async_mode:true (recommended), false when async_mode:false. " +
        "Pass explicit value to override.",
      ),
    },
    async ({ name, path, managed, include, async_mode, max_async_wait_minutes, overwrite, environment, background }) => {
      const args = ["solution", "export", "--name", name, "--path", path];
      if (managed) args.push("--managed", "true");
      if (include && include.length) args.push("--include", include.join(","));
      if (async_mode) args.push("--async", "true", "--max-async-wait-time", String(max_async_wait_minutes));
      if (overwrite) args.push("--overwrite", "true");
      if (environment) args.push("--environment", environment);
      // E4 fix: when async_mode is on (the recommended path), default background to true.
      // Data-driven: p95 of solution_export was 77.6s in 3 weeks of usage — past Claude
      // Desktop's default 60s MCP transport timeout. Forcing sync mode at p95 means the
      // tool returns "Request timed out" even though pac is still running successfully.
      // Caller can still opt back to sync with explicit `background:false`.
      const effectiveBackground = background ?? async_mode;
      if (effectiveBackground) return bg("solution_export", args);
      return runAsTool({
        toolName: "solution_export",
        binary: "pac",
        args,
        timeoutMs: (max_async_wait_minutes + 5) * 60 * 1000,
        hint: `Exported to ${path}. Use solution_unpack to extract source files for version control.`,
      });
    }
  );

  server.tool(
    "solution_clone",
    "Create a local solution project from an existing solution in the environment. Combines export + unpack into a single step. Long-running. Set background=true for fire-and-forget.",
    {
      name: z.string().describe("Solution unique name in the environment"),
      output_directory: z.string().describe("Local output directory for the cloned project"),
      package_type: PackageType.default("Both"),
      include: z.array(SolutionInclude).optional(),
      async_mode: z.boolean().default(true),
      max_async_wait_minutes: z.number().int().positive().max(60).default(30),
      localize: z.boolean().default(false),
      environment: z.string().optional(),
      background: z.boolean().default(false).describe("Return job id immediately; track via job_* tools"),
    },
    async ({ name, output_directory, package_type, include, async_mode, max_async_wait_minutes, localize, environment, background }) => {
      const args = [
        "solution", "clone",
        "--name", name,
        "--outputDirectory", output_directory,
        "--packagetype", package_type,
      ];
      if (include && include.length) args.push("--include", include.join(","));
      if (async_mode) args.push("--async", "true", "--max-async-wait-time", String(max_async_wait_minutes));
      if (localize) args.push("--localize", "true");
      if (environment) args.push("--environment", environment);
      if (background) return bg("solution_clone", args);
      return runAsTool({
        toolName: "solution_clone",
        binary: "pac",
        args,
        timeoutMs: (max_async_wait_minutes + 5) * 60 * 1000,
      });
    }
  );

  server.tool(
    "solution_publish",
    "Publish all customizations in the active (or specified) environment. Required after most metadata changes (forms, views, fields, sitemap) to make them visible to users. Affects the live environment. Set background=true for fire-and-forget.",
    {
      environment: z.string().optional().describe("Environment URL or ID; defaults to active"),
      async_mode: z.boolean().default(true).describe("Publish asynchronously"),
      max_async_wait_minutes: z.number().int().positive().max(60).default(15),
      background: z.boolean().default(false).describe("Return job id immediately; track via job_* tools"),
    },
    async ({ environment, async_mode, max_async_wait_minutes, background }) => {
      const args = ["solution", "publish"];
      if (environment) args.push("--environment", environment);
      if (async_mode) args.push("--async", "true", "--max-async-wait-time", String(max_async_wait_minutes));
      if (background) return bg("solution_publish", args);
      return runAsTool({
        toolName: "solution_publish",
        binary: "pac",
        args,
        timeoutMs: (max_async_wait_minutes + 5) * 60 * 1000,
      });
    }
  );

  server.tool(
    "solution_check",
    "Run the Power Apps Solution Checker analyzer against a local solution .zip or folder. Long-running (often 5-30 min). Returns a SARIF report path. Read-only — does not modify the environment. Set background=true for fire-and-forget.",
    {
      path: z.string().optional().describe("Path to one or more solution files (glob OK). Use this OR solution_url."),
      solution_url: z.string().optional().describe("SAS URL to a solution .zip (alternative to path)"),
      output_directory: z.string().describe("Where to write the analyzer report"),
      geo: z.string().optional().describe("Checker service region, e.g. UnitedStates, Europe, Asia"),
      rule_set: z.string().optional().describe("Rule set name or GUID (default: 'Solution Checker')"),
      excluded_files: z.string().optional().describe("Comma-separated file names to exclude"),
      save_results: z.boolean().default(false).describe("Save results to the env's Solution Health Hub"),
      environment: z.string().optional().describe("Required when save_results=true; defaults to active"),
      background: z.boolean().default(false).describe("Return job id immediately; track via job_* tools"),
    },
    async ({ path, solution_url, output_directory, geo, rule_set, excluded_files, save_results, environment, background }) => {
      if (!path && !solution_url) {
        return { isError: true, content: [{ type: "text", text: "Pass either 'path' or 'solution_url'." }] };
      }
      const args = ["solution", "check", "--outputDirectory", output_directory];
      if (path) args.push("--path", path);
      if (solution_url) args.push("--solutionUrl", solution_url);
      if (geo) args.push("--geo", geo);
      if (rule_set) args.push("--ruleSet", rule_set);
      if (excluded_files) args.push("--excludedFiles", excluded_files);
      if (save_results) args.push("--saveResults", "true");
      if (environment) args.push("--environment", environment);
      if (background) return bg("solution_check", args);
      return runAsTool({
        toolName: "solution_check",
        binary: "pac",
        args,
        timeoutMs: 30 * 60 * 1000,
      });
    }
  );
}
