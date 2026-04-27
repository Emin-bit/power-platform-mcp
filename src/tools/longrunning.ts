import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { backgroundResult } from "../jobs.js";

function blocked(reason: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `BLOCKED: ${reason}` }] };
}

const bg = (name: string, args: string[]) => backgroundResult(name, "pac", args);

const EnvType = z.enum(["Trial", "Sandbox", "Production", "Developer", "Teams", "SubscriptionBasedTrial"]);

export function registerLongRunning(server: McpServer) {
  // ===================================================================
  // SOLUTION IMPORT
  // ===================================================================
  server.tool(
    "solution_import",
    "Import a solution .zip into the active (or specified) Dataverse environment. DESTRUCTIVE: overwrites the named solution, may overwrite unmanaged customizations if force_overwrite=true. Long-running. " +
    "Default: blocks until done (up to max_wait_minutes). Set background=true to fire-and-forget — returns a job id; track with job_status/job_wait/admin_status.",
    {
      path: z.string().describe("Path to solution .zip"),
      environment: z.string().optional().describe("Override target env; defaults to active"),
      activate_plugins: z.boolean().default(true).describe("Activate plugins/workflows on import"),
      force_overwrite: z.boolean().default(false).describe("Overwrite unmanaged customizations (extra-destructive)"),
      skip_dependency_check: z.boolean().default(false),
      import_as_holding: z.boolean().default(false).describe("Import as holding solution; later run solution_upgrade"),
      stage_and_upgrade: z.boolean().default(false).describe("Import + apply upgrade in one step"),
      publish_changes: z.boolean().default(true).describe("Publish customizations after import"),
      settings_file: z.string().optional().describe("Deployment settings .json (connection refs / env vars)"),
      skip_lower_version: z.boolean().default(false),
      max_wait_minutes: z.number().int().positive().max(180).default(60),
      background: z.boolean().default(false).describe("Return job id immediately"),
      confirm: z.boolean().describe("Must be true (destructive)"),
    },
    async (a) => {
      if (!a.confirm) return blocked("solution_import is destructive. Re-call with confirm=true. Run whoami first to verify the target environment.");
      const args = ["solution", "import", "--path", a.path];
      if (a.environment) args.push("--environment", a.environment);
      if (a.activate_plugins) args.push("--activate-plugins", "true");
      if (a.force_overwrite) args.push("--force-overwrite", "true");
      if (a.skip_dependency_check) args.push("--skip-dependency-check", "true");
      if (a.import_as_holding) args.push("--import-as-holding", "true");
      if (a.stage_and_upgrade) args.push("--stage-and-upgrade", "true");
      if (a.publish_changes) args.push("--publish-changes", "true");
      if (a.settings_file) args.push("--settings-file", a.settings_file);
      if (a.skip_lower_version) args.push("--skip-lower-version", "true");
      args.push("--async", "true", "--max-async-wait-time", String(a.max_wait_minutes));

      if (a.background) return bg("solution_import", args);
      return runAsTool({
        toolName: "solution_import", binary: "pac", args,
        timeoutMs: (a.max_wait_minutes + 5) * 60 * 1000,
        hint: a.publish_changes ? undefined : "publish_changes was false — run solution_publish to make changes visible.",
      });
    }
  );

  // ===================================================================
  // SOLUTION UPGRADE
  // ===================================================================
  server.tool(
    "solution_upgrade",
    "Apply a pending holding-solution upgrade (replaces the previous version with the staged one). DESTRUCTIVE.",
    {
      solution_name: z.string().describe("Solution unique name"),
      environment: z.string().optional(),
      max_wait_minutes: z.number().int().positive().max(180).default(60),
      background: z.boolean().default(false),
      confirm: z.boolean(),
    },
    async (a) => {
      if (!a.confirm) return blocked("solution_upgrade replaces the prior version. Re-call with confirm=true.");
      const args = ["solution", "upgrade", "--solution-name", a.solution_name];
      if (a.environment) args.push("--environment", a.environment);
      args.push("--async", "true", "--max-async-wait-time", String(a.max_wait_minutes));
      if (a.background) return bg("solution_upgrade", args);
      return runAsTool({
        toolName: "solution_upgrade", binary: "pac", args,
        timeoutMs: (a.max_wait_minutes + 5) * 60 * 1000,
      });
    }
  );

  // ===================================================================
  // ENV CREATE
  // ===================================================================
  server.tool(
    "env_create",
    "Create a new Power Platform environment in the tenant. Requires admin role. May incur costs (Production tier especially). Long-running.",
    {
      name: z.string().describe("Environment display name"),
      region: z.string().default("unitedstates").describe("e.g. unitedstates, europe, asia, australia, india, japan, canada, unitedkingdom"),
      type: EnvType,
      currency: z.string().optional().describe("ISO currency code (default USD)"),
      language: z.string().optional().describe("Language LCID (e.g. 1033 for en-US)"),
      domain: z.string().optional().describe("Subdomain for the env URL"),
      templates: z.string().optional().describe("Comma-separated D365 templates, e.g. 'D365_Sample,D365_Sales'"),
      security_group_id: z.string().optional().describe("Required for Teams type"),
      user: z.string().optional().describe("Object ID or UPN for env owner"),
      max_wait_minutes: z.number().int().positive().max(60).default(30),
      background: z.boolean().default(false),
      confirm: z.boolean().describe("Must be true — creates a real PP resource"),
    },
    async (a) => {
      if (!a.confirm) return blocked("env_create may incur costs and creates a real Power Platform resource. Re-call with confirm=true.");
      const args = ["admin", "create", "--name", a.name, "--region", a.region, "--type", a.type];
      if (a.currency) args.push("--currency", a.currency);
      if (a.language) args.push("--language", a.language);
      if (a.domain) args.push("--domain", a.domain);
      if (a.templates) args.push("--templates", a.templates);
      if (a.security_group_id) args.push("--security-group-id", a.security_group_id);
      if (a.user) args.push("--user", a.user);
      args.push("--async", "true", "--max-async-wait-time", String(a.max_wait_minutes));
      if (a.background) return bg("env_create", args);
      return runAsTool({
        toolName: "env_create", binary: "pac", args,
        timeoutMs: (a.max_wait_minutes + 5) * 60 * 1000,
      });
    }
  );

  // ===================================================================
  // ENV COPY
  // ===================================================================
  server.tool(
    "env_copy",
    "Copy a source environment to a target environment. The TARGET IS OVERWRITTEN. DESTRUCTIVE for the target.",
    {
      source_environment: z.string().describe("Source env URL or ID (read from)"),
      target_environment: z.string().describe("Target env URL or ID — its content WILL BE OVERWRITTEN"),
      target_name: z.string().optional().describe("Optional new name for target after copy"),
      type: z.enum(["MinimalCopy", "FullCopy"]).default("FullCopy"),
      skip_audit_data: z.boolean().default(false),
      max_wait_minutes: z.number().int().positive().max(240).default(120),
      background: z.boolean().default(false),
      confirm: z.boolean(),
    },
    async (a) => {
      if (!a.confirm) return blocked("env_copy OVERWRITES the target environment. Re-call with confirm=true after running env_who/admin_env_list to verify source and target.");
      const args = [
        "admin", "copy",
        "--source-env", a.source_environment,
        "--target-env", a.target_environment,
        "--type", a.type,
      ];
      if (a.target_name) args.push("--name", a.target_name);
      if (a.skip_audit_data) args.push("--skip-audit-data", "true");
      args.push("--async", "true", "--max-async-wait-time", String(a.max_wait_minutes));
      if (a.background) return bg("env_copy", args);
      return runAsTool({
        toolName: "env_copy", binary: "pac", args,
        timeoutMs: (a.max_wait_minutes + 5) * 60 * 1000,
      });
    }
  );

  // ===================================================================
  // ENV BACKUP (not destructive)
  // ===================================================================
  server.tool(
    "env_backup",
    "Take a manual backup of an environment (default: active). Non-destructive. List backups via admin_list_backups.",
    {
      label: z.string().describe("Backup label / description"),
      environment: z.string().optional().describe("Override env; defaults to active"),
    },
    async ({ label, environment }) => {
      const args = ["admin", "backup", "--label", label];
      if (environment) args.push("--environment", environment);
      return runAsTool({
        toolName: "env_backup", binary: "pac", args,
        timeoutMs: 30 * 60 * 1000,
      });
    }
  );

  // ===================================================================
  // ENV RESTORE
  // ===================================================================
  server.tool(
    "env_restore",
    "Restore an environment from a backup. The target environment is OVERWRITTEN. DESTRUCTIVE.",
    {
      source_environment: z.string().describe("Source env (where the backup was taken)"),
      target_environment: z.string().optional().describe("Target env (defaults to source — rolls back the env)"),
      selected_backup: z.string().describe("Backup datetime in 'mm/dd/yyyy hh:mm' format OR 'latest'"),
      target_name: z.string().optional().describe("Optional new name for target after restore"),
      skip_audit_data: z.boolean().default(false),
      max_wait_minutes: z.number().int().positive().max(240).default(120),
      background: z.boolean().default(false),
      confirm: z.boolean(),
    },
    async (a) => {
      if (!a.confirm) return blocked("env_restore OVERWRITES the target environment. Re-call with confirm=true after admin_list_backups confirms the backup id.");
      const args = [
        "admin", "restore",
        "--source-env", a.source_environment,
        "--selected-backup", a.selected_backup,
      ];
      if (a.target_environment) args.push("--target-env", a.target_environment);
      if (a.target_name) args.push("--name", a.target_name);
      if (a.skip_audit_data) args.push("--skip-audit-data", "true");
      args.push("--async", "true", "--max-async-wait-time", String(a.max_wait_minutes));
      if (a.background) return bg("env_restore", args);
      return runAsTool({
        toolName: "env_restore", binary: "pac", args,
        timeoutMs: (a.max_wait_minutes + 5) * 60 * 1000,
      });
    }
  );

  // ===================================================================
  // ENV DELETE (irreversible)
  // ===================================================================
  server.tool(
    "env_delete",
    "Delete an environment from the tenant. IRREVERSIBLE outside the soft-delete recovery window. Requires admin role.",
    {
      environment: z.string().describe("Env URL or ID to delete"),
      max_wait_minutes: z.number().int().positive().max(60).default(15),
      background: z.boolean().default(false),
      confirm: z.boolean(),
    },
    async (a) => {
      if (!a.confirm) return blocked("env_delete is IRREVERSIBLE. Re-call with confirm=true after env_who or admin_env_list verifies the target.");
      const args = ["admin", "delete", "--environment", a.environment, "--async", "true", "--max-async-wait-time", String(a.max_wait_minutes)];
      if (a.background) return bg("env_delete", args);
      return runAsTool({
        toolName: "env_delete", binary: "pac", args,
        timeoutMs: (a.max_wait_minutes + 5) * 60 * 1000,
      });
    }
  );

  // ===================================================================
  // ENV RESET (irreversible wipe)
  // ===================================================================
  server.tool(
    "env_reset",
    "Reset an environment — WIPES ALL DATA AND CUSTOMIZATIONS, retaining only the env shell. IRREVERSIBLE outside soft-delete.",
    {
      environment: z.string(),
      currency: z.string().optional(),
      domain: z.string().optional(),
      name: z.string().optional(),
      language: z.string().optional(),
      purpose: z.string().optional(),
      templates: z.string().optional(),
      max_wait_minutes: z.number().int().positive().max(60).default(30),
      background: z.boolean().default(false),
      confirm: z.boolean(),
    },
    async (a) => {
      if (!a.confirm) return blocked("env_reset WIPES ALL DATA AND CUSTOMIZATIONS in the target. Re-call with confirm=true.");
      const args = ["admin", "reset", "--environment", a.environment];
      if (a.currency) args.push("--currency", a.currency);
      if (a.domain) args.push("--domain", a.domain);
      if (a.name) args.push("--name", a.name);
      if (a.language) args.push("--language", a.language);
      if (a.purpose) args.push("--purpose", a.purpose);
      if (a.templates) args.push("--templates", a.templates);
      args.push("--async", "true", "--max-async-wait-time", String(a.max_wait_minutes));
      if (a.background) return bg("env_reset", args);
      return runAsTool({
        toolName: "env_reset", binary: "pac", args,
        timeoutMs: (a.max_wait_minutes + 5) * 60 * 1000,
      });
    }
  );
}
