# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.5] — 2026-04-27 (Renamed to scoped npm package)

### Changed (BREAKING for npm install path only)
- **Package name**: `power-platform-mcp` → `@emin-bit/power-platform-mcp`. Reason: npm registry rejected the unscoped name as "too similar to existing package powerplatform-mcp" (one word vs hyphenated). Scoped names under your npm username are always available and are the standard solution for this conflict.
- **Install command** for end users:
  ```json
  "args": ["-y", "@emin-bit/power-platform-mcp"]
  ```
  (was `["-y", "power-platform-mcp"]`)
- **CLI setup**: `npx @emin-bit/power-platform-mcp setup` (was `npx power-platform-mcp setup`)
- The CLI binary name (`power-platform-mcp` from the `bin` field) and the MCP server name (`power-platform-mcp` in the `McpServer` constructor) are unchanged — only the npm distribution name moved to the `@emin-bit` scope.

### Notes
- v1.0.4 was tagged in git but never published to npm (publish was rejected by registry).
- All references in README, PUBLISHING.md, examples/claude_desktop_config.json, and tool descriptions updated to the scoped name.
- Logs, env vars (`PAC_MCP_*`), and the user-facing log dir (`~/.power-platform-mcp/logs/`) keep their existing names — no behavior change for existing local installs.

## [1.0.4] — 2026-04-27 (Onboarding & auto-install of pac/pacx)

### Added
- **`npx power-platform-mcp setup` CLI mode** — interactive 4-phase setup walkthrough that runs in the terminal BEFORE the user touches Claude Desktop config. Phases:
  1. Mandatory prerequisites (Node.js + .NET SDK) — verify only; aborts with download links if missing (these cannot be auto-installed).
  2. Auto-install pac and pacx via `dotnet tool install --global` (skipped if already present).
  3. Verify final state (full preflight).
  4. Manual steps (auth + Claude config + restart) — copy-pasteable config snippet printed.
- **`preflight` MCP tool** — read-only diagnostic that returns a structured report covering Node, .NET SDK, pac, pacx, PAC auth profiles, PACX auth profiles. Each missing/error item includes an actionable fix. Use this first when troubleshooting or onboarding.
- **`setup_install_pac_tools` MCP tool** — installs pac and pacx via `dotnet tool install --global`. Requires `confirm: true` (modifies user system, writes to `~/.dotnet/tools/`). **Mandatory prereq gate**: refuses to run if Node or .NET SDK is missing — clear error with download URLs.
- New `src/setup.ts` module with shared install/probe logic (used by both CLI mode and MCP tools).

### Design decisions
- **Mandatory vs. auto-installable split.** Node.js and .NET SDK are not auto-installable: they're large, OS-specific, often need admin, and have multiple distribution channels per OS. The setup gate makes this explicit and refuses to proceed until both are installed. pac and pacx, by contrast, are small .NET global tools that go into `~/.dotnet/tools/` without admin rights — those we install automatically.
- **Two entry points, one logic.** Both the CLI subcommand and the MCP tool delegate to the same `installPacTools()` function. Behavior and error paths are identical regardless of how the user invoked it.
- **Idempotent.** Already-installed tools are detected via `pac --version` / `pacx --version` probes and skipped; no `tool update` (which would overwrite a user's pinned version).
- **Safety.** `setup_install_pac_tools` requires `confirm: true` (per MCP convention for system-modifying ops). CLI mode is opt-in via the `setup` argv.

### Server instructions
- Updated server-level `instructions` (sent during MCP initialize) to point Claude at `preflight` first when troubleshooting or onboarding, and at `setup_install_pac_tools` for missing pac/pacx.

## [1.0.3] — 2026-04-26 (Tool selection guidance — PACX gap discovery)

### Background — the problem
When the user asked Claude to create a Dataverse table, Claude defaulted to `pac_help` / `pac_run` and missed PACX entirely (where the actual table-create tool lives). The user had to explicitly say "use PACX". This is a tool-selection bias caused by PAC being more prominent in tool descriptions and PACX gap-fillers being under-marketed.

### Added — Server-level instructions (MCP `instructions` field)
The MCP server now sends a comprehensive `instructions` block during the `initialize` handshake. Claude reads these at session start and uses them as system context when selecting tools. The instructions explicitly map:
- Which CLI covers which capability (PAC vs. PACX split)
- Which operations REQUIRE PACX (table/column/optionset/key/relationship/view CRUD — PAC has no equivalent)
- Discovery rule: when ambiguous, check BOTH pac_help and pacx_help
- Long-running ops should use background:true to bypass MCP transport timeout
- Destructive ops require confirm:true
- PACX has its own auth profile store, separate from PAC

### Changed — Tool descriptions
Strengthened descriptions on PACX gap-filler tools to lead with explicit guidance:
- `pacx_table_create` / `pacx_table_update` / `pacx_table_delete`: "USE THIS to create/update/delete a Dataverse table. ⚠️ PAC has NO direct table-* equivalent."
- `pacx_column_add` / `pacx_column_delete`: same pattern.
- `pacx_solution_create`: clarifies it creates the solution IN the env (not local scaffold like pac solution_init).
- `pacx_workflow_list/activate/deactivate`: marked as no-PAC-equivalent for batch flow operations.

Added cross-references in PAC tools that route to PACX:
- `pac_run` description now warns: "For Dataverse TABLE/COLUMN/OPTIONSET/KEY/RELATIONSHIP operations, use pacx_run or pacx_table_*/pacx_column_* tools instead — PAC does NOT support these directly."
- `pac_help` description now warns: "For data-model metadata operations, ALSO check pacx_help — PAC does not cover those domains."
- `pacx_help` similarly cross-references pac_help for solution lifecycle / env / canvas etc.

### Notes
- `instructions` is part of the MCP protocol and is supported by Claude Desktop, Claude Code, and other MCP clients. It is the architecturally correct place for server-wide tool-selection guidance.
- Backward-compatible — no tool signatures changed. Existing prompts work as before; what's improved is tool *discovery* by Claude.

## [1.0.2] — 2026-04-26 (MCP transport timeout workarounds)

### Background — the problem
Claude Desktop enforces an ~60s default MCP transport timeout per tool call, regardless of what the server reports. PACX operations against Dataverse (`table create`, `column add`, `publish all`) and large `solution_pack`/`unpack` regularly exceed this window. Server-side timeouts on these tools were already at 5-15 min, but Claude Desktop was killing the call from its side at 60s.

### Added — `background: true` on more tools
All tools likely to exceed 60s now expose a `background: true` parameter that bypasses the MCP transport timeout entirely: spawns the operation as a tracked job and returns the `job_id` immediately. Track via `job_status` / `job_wait` / `job_cancel`.

New tools with `background: true` in 1.0.2:
- **Passthrough**: `pac_run`, `pacx_run` (essential — escape hatch for any command)
- **PACX tables**: `pacx_table_create`, `pacx_table_update`, `pacx_table_delete`
- **PACX columns**: `pacx_column_add`, `pacx_column_delete`
- **PACX solutions**: `pacx_solution_create`, `pacx_solution_delete`
- **PACX publish**: `pacx_publish_all`
- **PACX workflows**: `pacx_workflow_activate`, `pacx_workflow_deactivate`
- **Solution Packager**: `solution_pack`, `solution_unpack` (large solutions)

Combined with 1.0.1 (export/publish/clone/check) and 1.0.0 Phase 3 (import/upgrade, env_create/copy/restore/delete/reset), background mode is now available on **27 long-running tools**.

### Documentation
- README troubleshooting expanded with explicit "Komanda otkaže oko 60 sekundi" section explaining the two-level timeout architecture (server vs. transport) and the two complementary fixes.
- `examples/claude_desktop_config.json` now includes `MCP_TIMEOUT: "600000"` (10 min) which Claude Desktop respects to raise the transport timeout — recommended baseline for power users running real PACX/PAC ops.

### Notes
- Even with `MCP_TIMEOUT` raised to 10 min, `background: true` is still recommended for genuinely long ops (solution import, env copy) so you can poll real-time progress via `job_status` instead of staring at a mute spinner.
- Behavior is backward-compatible: `background` defaults to `false`, existing prompts continue to work synchronously.

## [1.0.1] — 2026-04-26 (Bug fixes from live tenant test)

### Fixed
- **`pac_help` / `pacx_help`** now use the `help` subverb (e.g. `pac solution help`) instead of `--help` flag. PAC's `--help` triggered an "Error: Unneeded argument was passed" header before the actual usage text — now output is clean.
- **`env_fetch`** with inline `xml` arg auto-writes to a temp file under `os.tmpdir()` and uses `--xmlFile` internally. PAC 2.6.4's `--xml` inline argument crashes with `System.Xml.XmlException` on otherwise-valid FetchXML; routing through a temp file is the reliable path. Temp file is cleaned up in a `finally` block.
- **`env_fetch`** description now documents PAC quirks: `<fetch top='N'>` errors with paging conflict (use `count='N'`), and PAC pages through ALL results regardless of `count` (limit on the FetchXML side or accept full output).

### Added
- `background: true` parameter retroactively added to four Phase 2 long-running tools that previously only supported synchronous (PAC server-side async, blocking on our side) mode:
  - `solution_export`
  - `solution_publish`
  - `solution_clone`
  - `solution_check`
  All now consistently support fire-and-forget mode like Phase 3 destructive tools — returns a job id, track via `job_status` / `job_wait` / `job_cancel`.

### Refactored
- `backgroundResult` helper moved from `src/tools/longrunning.ts` (private) to `src/jobs.ts` (exported). All long-running tools now use the same shared helper, ensuring consistent behavior.

### Notes
- All fixes were identified during a live test against a real Power Platform tenant (PowerPlatform Topic Expert env). Test results are documented in the project notes.

## [1.0.0] — 2026-04-26

First production release. **101 tools** across all PAC namespaces and PACX Tier 1.

### Added (Phase 6 — Production polish)
- MIT LICENSE.
- CHANGELOG.
- npm publish metadata in `package.json` (description, keywords, repository, author).
- `.npmignore` excluding dev files; only `dist/`, `README.md`, `LICENSE`, `examples/` ship.
- Expanded README with per-namespace prompt examples and troubleshooting matrix.

## [0.5.0] — 2026-04-26 (Phase 5 — PACX Tier 1)

### Added — 27 PACX tools
- **PACX Auth** (separate profile store from PAC): `pacx_auth_list`, `pacx_auth_create`, `pacx_auth_select`, `pacx_auth_delete`, `pacx_auth_rename`, `pacx_auth_ping`.
- **PACX Solution** (with default-solution concept): `pacx_solution_list`, `pacx_solution_create`, `pacx_solution_delete`, `pacx_solution_get_default`, `pacx_solution_set_default`, `pacx_solution_get_publishers`.
- **PACX Table** (fills major PAC gap — direct table CRUD): `pacx_table_create`, `pacx_table_update`, `pacx_table_delete`, `pacx_table_print` (Mermaid diagrams), `pacx_table_export_metadata`.
- **PACX Column** (fills major PAC gap, type-discriminated): `pacx_column_add` (boolean/datetime/decimal/double/file/image/integer/memo/money/optionset/string), `pacx_column_delete`, `pacx_column_export_metadata`.
- **PACX Misc**: `pacx_publish_all`, `pacx_history_get`, `pacx_history_clear`, `pacx_history_set_length`, `pacx_workflow_list`, `pacx_workflow_activate`, `pacx_workflow_deactivate`.

### Notes
- Tier 2/3 PACX namespaces (optionset, key, rel, view, settings, forms, ribbon, webresources, unifiedrouting, project, script, tool, org, plugin) intentionally not mapped explicitly — accessible via `pacx_run` passthrough.
- PACX maintains its own auth profile store, separate from PAC. Mapped tools clearly distinguish (`pacx_auth_*` vs `auth_*`).

## [0.4.0] — 2026-04-26 (Phase 4 — Domain tools)

### Added — 29 PAC domain tools
- **Canvas Apps**: `canvas_list`, `canvas_download`, `canvas_pack`, `canvas_unpack`, `canvas_create`.
- **Power Pages**: `pages_list`, `pages_download`, `pages_upload` (destructive, `confirm:true`), `pages_clone`.
- **PCF**: `pcf_init`, `pcf_push` (destructive), `pcf_version`.
- **Plugin**: `plugin_init`, `plugin_push` (destructive).
- **Connection**: `connection_list`, `connection_create` (with secret masking), `connection_update`, `connection_delete` (destructive).
- **Connector**: `connector_list`, `connector_init`, `connector_create`, `connector_download`, `connector_update`.
- **Application**: `application_list`, `application_install` (destructive).
- **ModelBuilder**: `modelbuilder_build`.
- **Telemetry**: `telemetry_status`, `telemetry_enable`, `telemetry_disable`.

### Changed
- `safety.ts` recognizes additional force flags: `--forceUploadAll`, `--force-import`, `--force-upload-all`.

## [0.3.0] — 2026-04-26 (Phase 3 — Long-running ops + jobs)

### Added — 12 tools
- **Long-running operations** (each with `background: true` mode for fire-and-forget):
  - `solution_import`, `solution_upgrade`, `env_create`, `env_copy`, `env_backup`, `env_restore`, `env_delete`, `env_reset`.
- **Job tracking** (in-memory, in-session): `job_list`, `job_status`, `job_wait`, `job_cancel`.
- Graceful shutdown: SIGINT/SIGTERM/SIGHUP handlers kill tracked background jobs before exit.

### Notes
- `pac package deploy` does not exist in PAC 2.6 (only `package init/add-*` for building) — intentionally skipped.
- Background `job_cancel` only kills the local pac process. Server-side Power Platform operations may continue — use `admin_status` for server-side state.

## [0.2.0] — 2026-04-26 (Phase 2 — Typed wrappers)

### Added — 21 PAC typed wrapper tools
- **Environment**: `env_who`, `env_list`, `env_select`, `env_list_settings`, `env_fetch` (FetchXML query).
- **Admin (read-only)**: `admin_env_list`, `admin_status`, `admin_list_backups`, `admin_list_tenant_settings`, `admin_list_groups`, `admin_list_app_templates`.
- **Solution**: `solution_list`, `solution_online_version`, `solution_init`, `solution_pack`, `solution_unpack`, `solution_version`, `solution_create_settings`, `solution_export`, `solution_clone`, `solution_publish`, `solution_check`.

### Pivot from original Phase 2 plan
- Original spec called for "structured JSON output". Investigation showed PAC 2.6.4 and PACX 1.x have **no `--json` flag anywhere**. JSON parsing was infeasible.
- Pivoted to: typed wrappers with Zod schemas, sensible defaults, explicit destructive markers, cross-validation, redacted secrets — even without JSON parsing, this is dramatically better UX than raw passthrough.

## [0.1.0] — 2026-04-25 (Phase 1 — MVP)

### Added — 12 tools (foundation)
- **Auth**: `whoami`, `auth_list`, `auth_select`, `auth_delete`, `auth_create_service_principal`, `auth_create_service_principal_cert`, `auth_create_device_code`, `auth_create_interactive`.
- **Discovery**: `pac_help`, `pacx_help`.
- **Generic passthrough**: `pac_run`, `pacx_run` — full coverage of PAC/PACX, current and future commands.

### Foundation
- TypeScript on Node.js, MCP SDK `@modelcontextprotocol/sdk` ^1.0.4.
- Cross-platform PAC binary discovery: macOS/Linux (`~/.dotnet/tools`, `/usr/local/share/dotnet`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`), Windows (`%USERPROFILE%\.dotnet\tools`, `%LOCALAPPDATA%\Microsoft\PowerAppsCli`). `PAC_BIN_PATH`/`PACX_BIN_PATH` env override.
- Safe-mode (default ON) blocking destructive operations (delete/reset/restore/wipe + force flags) without `confirm: true`.
- Secret masking (`--clientSecret`, `--password`, `--certificatePassword` and aliases) in logs and tool output.
- Daily-rotated JSON Lines log file at `~/.power-platform-mcp/logs/pac-mcp-YYYY-MM-DD.log`.
- Verbose mode via `PAC_MCP_VERBOSE=1`.
- Smoke test script (`smoke-test.mjs`) covering initialize, tools/list, real `pac_help` execution, safe-mode block.
