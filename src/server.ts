import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPassthrough } from "./tools/passthrough.js";
import { registerHelp } from "./tools/help.js";
import { registerAuth } from "./tools/auth.js";
import { registerEnvironment } from "./tools/environment.js";
import { registerAdmin } from "./tools/admin.js";
import { registerSolution } from "./tools/solution.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerLongRunning } from "./tools/longrunning.js";
import { registerCanvas } from "./tools/canvas.js";
import { registerPages } from "./tools/pages.js";
import { registerPcf } from "./tools/pcf.js";
import { registerPlugin } from "./tools/plugin.js";
import { registerConnection } from "./tools/connection.js";
import { registerConnector } from "./tools/connector.js";
import { registerTelemetry } from "./tools/telemetry.js";
import { registerApplication } from "./tools/application.js";
import { registerModelBuilder } from "./tools/modelbuilder.js";
import { registerPacxAuth } from "./tools/pacx_auth.js";
import { registerPacxSolution } from "./tools/pacx_solution.js";
import { registerPacxTable } from "./tools/pacx_table.js";
import { registerPacxColumn } from "./tools/pacx_column.js";
import { registerPacxMisc } from "./tools/pacx_misc.js";
import { registerPreflight } from "./tools/preflight.js";
import { log, getLogDir } from "./logger.js";
import { safeModeEnabled } from "./safety.js";
import { getEffectivePath } from "./pac.js";
import { killAllRunning } from "./jobs.js";

export const VERSION = "1.0.4";

const SERVER_INSTRUCTIONS = `
Power Platform MCP server. This server bridges TWO complementary CLIs:

  • pac   — Microsoft Power Platform CLI (auth, env, solution lifecycle, canvas/pages/PCF/plugin/connection/connector/application/modelbuilder/telemetry)
  • pacx  — Greg Xrm Command Extended (PACX) — covers Dataverse operations PAC does NOT directly support

CRITICAL CAPABILITY MAPPING — use the right tool for the task:

  TABLE create / update / delete / metadata:        ALWAYS use pacx_table_*  (PAC has no direct equivalent)
  COLUMN add / delete / metadata:                    ALWAYS use pacx_column_* (PAC has no direct equivalent)
  Direct SOLUTION create (just a new shell):         use pacx_solution_create (PAC's solution_init creates a local project, not in env)
  OPTIONSET, KEY, RELATIONSHIP, VIEW manipulation:   ALWAYS use pacx_run (those PACX namespaces aren't explicitly mapped yet)
  Batch WORKFLOW activate/deactivate:                use pacx_workflow_*
  Manual PUBLISH after metadata changes:             pacx_publish_all  OR  solution_publish (both work)

  Solution IMPORT/EXPORT/PACK/UNPACK/CHECK:          use pac (solution_*) — PACX doesn't cover these
  Authentication, environments, admin ops:           use pac (auth_*, env_*, admin_*)
  Canvas apps, Power Pages, PCF, plugins:            use pac (canvas_*, pages_*, pcf_*, plugin_*)

DISCOVERY RULE — when the user's intent is ambiguous, especially for any Dataverse data-model operation
(tables, columns, choice fields, relationships, alternate keys), CHECK BOTH pac_help AND pacx_help before
deciding. Do NOT default to pac_run for table/column ops — that path doesn't exist in PAC.

CONTEXT VERIFICATION — call whoami before any destructive operation to confirm which tenant/environment
will be affected. Active environment from PAC and from PACX may differ — they have separate auth profile stores.

LONG-RUNNING OPERATIONS — Claude Desktop enforces a ~60s MCP transport timeout. Operations against Dataverse
that may exceed 60s (table create, column add, publish all, large solution import/export, env copy/restore)
should use the 'background: true' parameter where available — returns a job id immediately, track via
job_status / job_wait / job_cancel. The MCP_TIMEOUT env var (set in Claude Desktop config) raises the
transport timeout to 10 min, but background mode is the more robust path for genuinely long ops.

DESTRUCTIVE OPERATIONS — safe-mode (default ON) blocks delete/reset/restore/wipe/--force commands without
explicit confirm: true. The block is correct — re-call with confirm: true after running whoami.

PACX has its OWN auth profile store separate from PAC. Run pacx_auth_list / pacx_auth_create / pacx_auth_select
to manage PACX profiles. Doing 'pac auth select' does NOT affect PACX, and vice versa.

ONBOARDING / TROUBLESHOOTING — when a user first connects this MCP, or reports tool failures, run the
preflight tool. It checks Node, .NET SDK, pac, pacx, and auth profiles, and returns actionable fixes for
anything missing. If pac or pacx is missing, call setup_install_pac_tools (with confirm: true) to install
them via dotnet tool install — but .NET SDK itself must be installed manually by the user (link provided).
`.trim();

export async function startServer(): Promise<void> {
  const server = new McpServer(
    { name: "power-platform-mcp", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerAuth(server);
  registerEnvironment(server);
  registerAdmin(server);
  registerSolution(server);
  registerLongRunning(server);
  registerCanvas(server);
  registerPages(server);
  registerPcf(server);
  registerPlugin(server);
  registerConnection(server);
  registerConnector(server);
  registerApplication(server);
  registerModelBuilder(server);
  registerTelemetry(server);
  registerPacxAuth(server);
  registerPacxSolution(server);
  registerPacxTable(server);
  registerPacxColumn(server);
  registerPacxMisc(server);
  registerPreflight(server);
  registerJobTools(server);
  registerHelp(server);
  registerPassthrough(server);

  // Kill tracked background jobs on shutdown so we don't leave orphan pac processes.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      log("info", "shutdown signal", { signal: sig });
      killAllRunning();
      process.exit(0);
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("info", "server started", {
    version: VERSION,
    pid: process.pid,
    safeMode: safeModeEnabled(),
    logDir: getLogDir(),
    effectivePath: getEffectivePath(),
    platform: process.platform,
    node: process.version,
  });
}
