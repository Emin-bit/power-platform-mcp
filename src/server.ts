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
import { registerCanvasMsapp } from "./tools/canvas-msapp.js";
import { registerCanvasLayer } from "./tools/canvas-layer.js";
import { registerPpToken } from "./tools/pp_token.js";
import { registerSelfReview } from "./tools/pp_self_review.js";
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

export const VERSION = "1.2.0";

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

CANVAS APP PACK/EDIT (Phase D, v1.1.0+) — when a user edits canvas app YAML and needs the change to
ACTUALLY reach Studio, use the canvas_*_sync family in this MCP instead of \`pac canvas pack\`. Microsoft's
own docs (PowerApps-Tooling KnownIssues.md, PA3013) confirm \`pac canvas pack\` does NOT sync YAML →
Controls/*.json InvariantScript, so YAML edits silently never reach the live app.
  • canvas_pack_sync       — pack a sources/ dir + sync every YAML formula into the matching JSON Rule.
  • canvas_patch_property  — surgical: change ONE control.property without unpack/pack round-trip.
  • canvas_diff            — preview which controls/properties differ between two .msapp or two source dirs.
  • canvas_validate_yaml   — pre-flight: catch missing leading '=' and other YAML grammar mistakes BEFORE pack.
These are all LOCAL-ONLY operations — no tenant call, no network.

DIRECT DATAVERSE WEB API (Phase E, v1.2.0+) — for canvas-app solution layer issues that PAC can't touch
(active unmanaged layer from a different publisher blocking import, etc.), use:
  • canvas_layer_inspect  — read solution component layers via Web API RetrieveSolutionComponentLayers.
  • canvas_layer_remove   — DESTRUCTIVE, removes active unmanaged customization layer via Web API
                            RemoveActiveCustomizations action. Always inspect first.
  • pp_token              — acquire a short-lived Dataverse bearer token (used internally by the canvas_layer_*
                            tools; can also be invoked directly when you need to call other Web API endpoints).
                            PREREQ: 'az login --tenant <yourtenant>' (or 'Connect-AzAccount') recently on this machine.

OBSERVABILITY (Phase E, v1.2.0+) — every tool call that fails (exit ≠ 0 or timed out) is now logged at the
'error' level with stderr captured into the daily JSON log at ~/.power-platform-mcp/logs/. The log also has
homedir + OS username redacted, so you can safely share log files for troubleshooting.

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

╔════════════════════════════════════════════════════════════════════════════════════════════════╗
║  PHASE F (v1.2.0) — EMBEDDED EXPERT KNOWLEDGE FOR REPEATED WORKFLOWS                           ║
║  This block was added based on mining 17 days of real-world usage logs.                        ║
╚════════════════════════════════════════════════════════════════════════════════════════════════╝

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #1 — AUTH ONCE PER SESSION, VERIFY BEFORE EVERY DESTRUCTIVE OP
══════════════════════════════════════════════════════════════════════════════════════════════════
At session start:
  1. Run \`whoami\`. If it errors or shows a profile the user doesn't recognize, ask them to clarify
     the target environment, then run \`auth_list\`, \`auth_select\`, and \`env_select\` AS NEEDED.
  2. Show the user the active tenant + environment + user, and CONFIRM before any other operation.
  3. After this initial verification, do NOT ask the user for credentials, ClientId, secrets, or
     tenant IDs again for the rest of the session. Treat the active profile as the source of truth.

Before EVERY \`solution_import\`, \`env_delete\`, \`env_reset\`, \`env_restore\`, \`env_copy\`,
\`pacx_table_delete\`, OR ANY operation that mutates the tenant:
  - The MCP runs \`pac env who\` internally as a guard when you pass \`expected_environment_url\`
    or \`expected_tenant_substring\` to solution_import. **ALWAYS PASS ONE OF THESE for any import
    against a production tenant.** Real incident: user once imported into the wrong tenant because
    the active pac auth profile had silently changed between sessions. The Phase F guardrail in
    solution_import prevents this.
  - For other destructive operations without built-in expected_* args, call \`whoami\` immediately
    before to surface the active context in your own response, then proceed.

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #2 — CANVAS APP DEPLOY RECIPE (the workflow that caused the most pain)
══════════════════════════════════════════════════════════════════════════════════════════════════
Goal: edit a Power Apps canvas app and have changes ACTUALLY reach Studio.

The PA3013 bug: \`pac canvas pack\` (Microsoft's CLI) silently does NOT sync \`Src/*.pa.yaml\`
edits into \`Controls/*.json\`. Studio reads from JSON. Result: pack returns exit 0, import
"succeeds", but the live app doesn't have your changes. **Always use canvas_pack_sync for any
pack operation that follows an edit.**

THE CORRECT WORKFLOW — every time:

  ┌─────────────────────────────────────────────────────────────────────────────────────────┐
  │  Step 1.  whoami                                                                        │
  │          → confirms source environment.                                                 │
  │                                                                                         │
  │  Step 2.  canvas_list                                                                   │
  │          → confirms the app exists in this env + grabs its App ID (GUID).               │
  │                                                                                         │
  │  Step 3.  canvas_download --name <app-id-or-name> --extract-to-directory <workdir>      │
  │          → downloads + unpacks in one step. Use App ID (GUID) when the name has         │
  │            special chars or umlauts (Lamello apps with German names hit this).          │
  │                                                                                         │
  │  Step 4.  Make YAML edits in <workdir>/Src/*.pa.yaml.                                    │
  │          → For a single-property edit, prefer canvas_patch_property on the .msapp        │
  │            directly (skips Steps 3 + 5 + 6).                                              │
  │                                                                                         │
  │  Step 5.  canvas_validate_yaml --sources <workdir>                                       │
  │          → catches missing leading '=', single-line ':' or '#' violations BEFORE         │
  │            pack. Run this every time — a typo here = silent pack failure later.          │
  │                                                                                         │
  │  Step 6.  canvas_pack_sync --sources <workdir> --output <workdir>/repacked.msapp         │
  │                            --confirm true                                                │
  │          → packs AND writes YAML formulas into JSON Rules. This is the Phase D fix       │
  │            for PA3013. Default allow_add_new=false is correct for round-trips —          │
  │            only set true if you've ADDED new properties to the YAML that the JSON        │
  │            doesn't have yet.                                                             │
  │                                                                                         │
  │  Step 7.  canvas_diff --left <original.msapp> --right <workdir>/repacked.msapp           │
  │          → preview: which properties changed. Sanity check before uploading.             │
  │                                                                                         │
  │  Step 8.  IMPORTANT — pac has NO direct upload for canvas apps. The .msapp must reach    │
  │           the tenant via a SOLUTION. Two paths:                                          │
  │                                                                                         │
  │           (a) IF the app already lives in a solution you own (typical for managed apps): │
  │               • solution_export the wrapping solution                                    │
  │               • solution_unpack it                                                       │
  │               • replace the canvas .msapp in CanvasApps/<schema>/<schema>_DocumentUri/    │
  │               • solution_pack with the new .msapp                                        │
  │               • solution_import with expected_environment_url=<TARGET>                   │
  │                                                                                         │
  │           (b) For default-solution apps or quick test imports:                           │
  │               • Use Power Apps Studio "Import canvas app" via web UI. No pac path.       │
  │                                                                                         │
  │  Step 9.  After import, verify in Studio that the change is live. If not, run            │
  │           canvas_layer_inspect on the app's GUID — if an active unmanaged layer from     │
  │           a previous publisher is shadowing your import, canvas_layer_remove will        │
  │           clear it (DESTRUCTIVE, inspect first).                                          │
  └─────────────────────────────────────────────────────────────────────────────────────────┘

COMMON FAILURE MODES + RECOVERY:
  • Pack returns 'unexpected output: .' or empty stdout — almost always a YAML syntax error.
    Re-run canvas_validate_yaml. Most common: missing leading '=' in a property formula.
  • Studio still shows old version after import — check canvas_layer_inspect for an active
    unmanaged customization layer from a different publisher. Use canvas_layer_remove if found.
  • Import fails with "solution X is currently being processed" — wait 60s and retry; previous
    import didn't fully publish.
  • Solution_export of a managed solution silently returns the unmanaged form — managed-solution
    export is restricted; you need the unmanaged source.

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #3 — POWER FX SYNTAX CHEATSHEET (May 2026 grammar)
══════════════════════════════════════════════════════════════════════════════════════════════════
These are the recurring syntax mistakes that surface as 'pack returned exit 0 but Studio shows
broken formula'. Memorize:

  • Decimal is the DEFAULT numeric type for NEW canvas apps (28 digits, base-10, exact). Apps
    created BEFORE the late-2024 Decimal-default switch still default to Number (Float) unless
    explicitly opted in via the app's settings. \`2 * 2\` returns Decimal in new apps; in legacy
    apps it returns Float. Use Float() for scientific computations / huge ranges only.
  • String concatenation is '&', NOT '+':  "Hello, " & UserName     ❌  "Hello, " + UserName
  • Logical ops:  &&  ||  !       (Excel-equivalent And/Or/Not also work).
  • Comparison ops:  =  <>  <  <=  >  >=    (NOT == or !=, those are JS habits).
  • Property selector: '.'   (legacy '!' only for backward compat).
  • In YAML, EVERY formula MUST start with '='. Bare values are rejected:
        Visible: =true             ✓
        Visible: true              ✗ (will throw silent pack error in canvas_validate_yaml)
  • Single-line YAML formulas CANNOT contain ':' or '#' — convert to block-scalar with '|-':
        OnStart: |-
          =Set(x, "https://contoso.sharepoint.com/sites/X");
          Notify("Done")
  • There is NO if/else if statement — only the If() function:  If(cond, then, [elseIf, then,] else)
  • There is NO for loop — use ForAll(table, body)  (returns a table, never mutates).
  • There is NO try/catch — use IfError(expr, fallback) or IsError(expr).
  • ParseJSON returns Dynamic (Untyped Object). Convert explicitly: Value(json.amount), Text(json.name).

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #4 — FLOW (POWER AUTOMATE) WORKFLOWS
══════════════════════════════════════════════════════════════════════════════════════════════════
Power Automate "Flows" are Dataverse workflows. Categories matter — PAC and PACX use category
codes:

  Category 0  = Workflow — classic background/real-time workflows
  Category 1  = Dialog — classic dialog workflows (mostly retired)
  Category 2  = BusinessRule
  Category 3  = Action — custom Dataverse actions
  Category 4  = BusinessProcessFlow — BPF (visual stages)
  Category 5  = ModernFlow — Power Automate cloud flows (what most users mean by "flow")
  Category 6  = DesktopFlow — Power Automate Desktop RPA
  Category 7  = AIFlow — AI/Copilot extensions
(Source of truth: the WorkflowCategory enum in pacx_misc.ts.)

Use pacx_workflow_list with --category 'ModernFlow' to list cloud flows. For batch activation
or deactivation, use pacx_workflow_activate / pacx_workflow_deactivate. Single workflows can be
filtered by --name (substring match).

Flow JSON in solutions lives at \`Workflows/<schemaname>/\`. Each cloud flow is one JSON definition.
Edits to flow JSON inside an unpacked solution are pack/import-safe — no PA3013-style sync bug.

KNOWN PAIN POINT: \`pacx workflow list --solution '*'\` (wildcard across all solutions) historically
times out at 60s on tenants with hundreds of workflows. Phase E (1.2.0) auto-routes that pattern
to background mode. For interactive use, prefer scoping by solution name.

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #5 — env_fetch (Dataverse FetchXML) — KNOWN QUIRKS
══════════════════════════════════════════════════════════════════════════════════════════════════
PAC's \`env fetch\` has 3 footguns the MCP pre-flights for you:
  1. \`<fetch top='N'>\` triggers Dataverse paging conflict — use \`<fetch count='N'>\` instead.
     env_fetch rejects this client-side with a fix hint.
  2. Inline XML through PAC's --xml flag crashes with XmlException on some inputs — the MCP
     auto-routes to --xmlFile through a temp file. Transparent to you.
  3. PAC pages through ALL results regardless of \`count\` — limit on the FetchXML side or accept
     full output.

When env_fetch fails, the MCP now post-processes stderr to surface actionable hints:
"replace top='N' with count='N'", "active auth profile expired — run auth_select", etc.

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #6 — PERIODIC SELF-REVIEW
══════════════════════════════════════════════════════════════════════════════════════════════════
Call \`pp_self_review\` periodically (weekly or after any major workflow) to surface:
  • Which tools failed and why (stderr extracts since 1.2.0).
  • Slow operations that should be moved to background mode.
  • Canvas-workflow incomplete chains (download → unpack → no pack).
  • Solution_import calls without a recent whoami (tenant-safety audit).
  • Week-over-week trend in failure rate.

Output is local-only and homedir/username redacted, so it's safe to paste into chat or issues.
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
  registerCanvasMsapp(server);
  registerCanvasLayer(server);
  registerPpToken(server);
  registerSelfReview(server);
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
