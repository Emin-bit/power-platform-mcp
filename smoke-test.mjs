// Smoke test: spawn the built MCP server, send initialize + tools/list + a real tool call,
// verify everything responds. Exits 0 on success, 1 on failure.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "dist/index.js");

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PAC_MCP_VERBOSE: "1" },
});

let stdoutBuf = "";
let stderrBuf = "";
const responses = new Map();

child.stdout.on("data", chunk => {
  stdoutBuf += chunk.toString();
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) responses.set(msg.id, msg);
    } catch (err) {
      console.error("non-JSON line from server:", line);
    }
  }
});

child.stderr.on("data", c => { stderrBuf += c.toString(); });

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

async function waitFor(id, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (responses.has(id)) return responses.get(id);
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timeout waiting for response id=${id}`);
}

async function main() {
  send({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0.0" },
    },
  });
  const initRes = await waitFor(1);
  if (initRes.error) throw new Error(`initialize failed: ${JSON.stringify(initRes.error)}`);
  console.log("OK initialize");

  // 1.0.3: server must send `instructions` field with tool-selection guidance
  const instructions = initRes.result?.instructions ?? "";
  if (!instructions || instructions.length < 200) {
    throw new Error("REGRESSION (1.0.3): server instructions missing or too short");
  }
  for (const required of ["pacx_table_", "pacx_column_", "pacx_help", "background", "whoami"]) {
    if (!instructions.includes(required)) {
      throw new Error(`REGRESSION (1.0.3): server instructions missing reference to '${required}'`);
    }
  }
  console.log(`OK server sent instructions (${instructions.length} chars, references PACX gap-fillers)`);

  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listRes = await waitFor(2);
  if (listRes.error) throw new Error(`tools/list failed: ${JSON.stringify(listRes.error)}`);
  const toolNames = (listRes.result?.tools ?? []).map(t => t.name).sort();
  console.log("OK tools/list:", toolNames.join(", "));

  const expected = [
    // Phase 1
    "auth_create_device_code",
    "auth_create_interactive",
    "auth_create_service_principal",
    "auth_create_service_principal_cert",
    "auth_delete",
    "auth_list",
    "auth_select",
    "pac_help",
    "pac_run",
    "pacx_help",
    "pacx_run",
    "whoami",
    // Phase 2 — environment
    "env_who",
    "env_list",
    "env_select",
    "env_list_settings",
    "env_fetch",
    // Phase 2 — admin (read)
    "admin_env_list",
    "admin_status",
    "admin_list_backups",
    "admin_list_tenant_settings",
    "admin_list_groups",
    "admin_list_app_templates",
    // Phase 2 — solution
    "solution_list",
    "solution_online_version",
    "solution_init",
    "solution_pack",
    "solution_unpack",
    "solution_version",
    "solution_create_settings",
    "solution_export",
    "solution_clone",
    "solution_publish",
    "solution_check",
    // Phase 3 — long-running
    "solution_import",
    "solution_upgrade",
    "env_create",
    "env_copy",
    "env_backup",
    "env_restore",
    "env_delete",
    "env_reset",
    // Phase 3 — jobs
    "job_list",
    "job_status",
    "job_wait",
    "job_cancel",
    // Phase 4 — canvas
    "canvas_list",
    "canvas_download",
    "canvas_pack",
    "canvas_unpack",
    "canvas_create",
    // Phase 4 — pages
    "pages_list",
    "pages_download",
    "pages_upload",
    "pages_clone",
    // Phase 4 — pcf
    "pcf_init",
    "pcf_push",
    "pcf_version",
    // Phase 4 — plugin
    "plugin_init",
    "plugin_push",
    // Phase 4 — connection
    "connection_list",
    "connection_create",
    "connection_update",
    "connection_delete",
    // Phase 4 — connector
    "connector_list",
    "connector_init",
    "connector_create",
    "connector_download",
    "connector_update",
    // Phase 4 — telemetry / application / modelbuilder
    "telemetry_status",
    "telemetry_enable",
    "telemetry_disable",
    "application_list",
    "application_install",
    "modelbuilder_build",
    // Phase 5 — pacx auth
    "pacx_auth_list",
    "pacx_auth_create",
    "pacx_auth_select",
    "pacx_auth_delete",
    "pacx_auth_rename",
    "pacx_auth_ping",
    // Phase 5 — pacx solution
    "pacx_solution_list",
    "pacx_solution_create",
    "pacx_solution_delete",
    "pacx_solution_get_default",
    "pacx_solution_set_default",
    "pacx_solution_get_publishers",
    // Phase 5 — pacx table
    "pacx_table_create",
    "pacx_table_update",
    "pacx_table_delete",
    "pacx_table_print",
    "pacx_table_export_metadata",
    // Phase 5 — pacx column
    "pacx_column_add",
    "pacx_column_delete",
    "pacx_column_export_metadata",
    // Phase 5 — pacx misc
    "pacx_publish_all",
    "pacx_history_get",
    "pacx_history_clear",
    "pacx_history_set_length",
    "pacx_workflow_list",
    "pacx_workflow_activate",
    "pacx_workflow_deactivate",
  ];
  const missing = expected.filter(n => !toolNames.includes(n));
  if (missing.length) throw new Error(`Missing tools: ${missing.join(", ")}`);

  send({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "pac_help", arguments: { path: "" } },
  });
  const helpRes = await waitFor(3, 30000);
  if (helpRes.error) throw new Error(`pac_help failed: ${JSON.stringify(helpRes.error)}`);
  const helpText = helpRes.result?.content?.[0]?.text ?? "";
  if (!helpText.toLowerCase().includes("usage") && !helpText.toLowerCase().includes("commands") && !helpText.toLowerCase().includes("verbs")) {
    console.warn("WARNING: pac_help output doesn't look like help text:", helpText.slice(0, 200));
  } else {
    console.log("OK pac_help (output length:", helpText.length, "chars)");
  }

  send({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "pac_run", arguments: { args: "solution delete --solution-name Foo" } },
  });
  const blockRes = await waitFor(4, 10000);
  const blockText = blockRes.result?.content?.[0]?.text ?? "";
  if (!blockRes.result?.isError || !blockText.includes("BLOCKED")) {
    throw new Error(`Expected destructive command to be blocked, got: ${JSON.stringify(blockRes.result)}`);
  }
  console.log("OK safe-mode blocked destructive command");

  // Phase 3: missing confirm on solution_import → BLOCKED
  send({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "solution_import", arguments: { path: "/tmp/nope.zip", confirm: false } },
  });
  const importBlockRes = await waitFor(5, 10000);
  const importBlockText = importBlockRes.result?.content?.[0]?.text ?? "";
  if (!importBlockRes.result?.isError || !importBlockText.includes("BLOCKED")) {
    throw new Error(`Expected solution_import without confirm to be blocked, got: ${JSON.stringify(importBlockRes.result)}`);
  }
  console.log("OK solution_import blocked without confirm");

  // Phase 3: job tracking — start an empty pac help job in background, then check it
  send({
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "job_list", arguments: {} },
  });
  const jobListRes = await waitFor(6, 10000);
  const jobListText = jobListRes.result?.content?.[0]?.text ?? "";
  if (jobListText !== "(no jobs)") {
    console.warn("WARNING: job_list expected '(no jobs)' on fresh server, got:", jobListText);
  } else {
    console.log("OK job_list returns empty on fresh server");
  }

  // 1.0.1 regression checks
  // Fix #1: pac_help no longer emits "Unneeded argument was passed"
  if (helpText.includes("Unneeded argument")) {
    throw new Error("REGRESSION: pac_help output contains 'Unneeded argument' — fix #1 broken");
  }
  console.log("OK pac_help has no 'Unneeded argument' header (fix #1)");

  // Fix #2 + #3: env_fetch description mentions temp-file routing and count/paging quirk
  const fetchTool = listRes.result?.tools?.find(t => t.name === "env_fetch");
  const fetchDesc = fetchTool?.description ?? "";
  if (!fetchDesc.includes("temp file") && !fetchDesc.includes("auto-written")) {
    throw new Error("REGRESSION: env_fetch description missing temp-file routing note — fix #2 broken");
  }
  if (!fetchDesc.includes("count")) {
    throw new Error("REGRESSION: env_fetch description missing count/paging note — fix #3 broken");
  }
  console.log("OK env_fetch description documents temp-file routing and paging quirk (fixes #2 + #3)");

  // Fix #4: solution_export/publish/clone/check have background:true parameter
  for (const name of ["solution_export", "solution_publish", "solution_clone", "solution_check"]) {
    const tool = listRes.result?.tools?.find(t => t.name === name);
    if (!tool?.inputSchema?.properties?.background) {
      throw new Error(`REGRESSION: ${name}.background parameter missing — fix #4 broken`);
    }
  }
  console.log("OK solution_export/publish/clone/check all expose background:true (fix #4)");

  // 1.0.4 regression: preflight + setup_install_pac_tools must be registered
  const onboardingTools = ["preflight", "setup_install_pac_tools"];
  for (const name of onboardingTools) {
    const tool = listRes.result?.tools?.find(t => t.name === name);
    if (!tool) {
      throw new Error(`REGRESSION (1.0.4): ${name} tool not registered`);
    }
  }
  console.log(`OK ${onboardingTools.length} onboarding tools registered (preflight, setup_install_pac_tools)`);

  // 1.0.2 regression: passthrough + PACX + solution_pack/unpack also expose background:true
  const bgRequiredTools = [
    "pac_run", "pacx_run",
    "pacx_table_create", "pacx_table_update", "pacx_table_delete",
    "pacx_column_add", "pacx_column_delete",
    "pacx_solution_create", "pacx_solution_delete",
    "pacx_publish_all",
    "pacx_workflow_activate", "pacx_workflow_deactivate",
    "solution_pack", "solution_unpack",
  ];
  for (const name of bgRequiredTools) {
    const tool = listRes.result?.tools?.find(t => t.name === name);
    if (!tool?.inputSchema?.properties?.background) {
      throw new Error(`REGRESSION (1.0.2): ${name}.background parameter missing — MCP transport timeout fix broken`);
    }
  }
  console.log(`OK ${bgRequiredTools.length} tools expose background:true (1.0.2 transport timeout fix)`);

  // Total tool count assertion (Phase E review nit #17): keep description string + actual count in sync.
  if (listRes.result.tools.length !== 118) {
    throw new Error(
      `Total tool count mismatch: package.json description claims 118, actual = ${listRes.result.tools.length}. ` +
      `Update both in tandem when adding or removing tools.`,
    );
  }
  console.log("OK 118 total tools registered (description string matches)");

  // Phase F: pp_self_review tool registered + GOLDEN RULES in instructions.
  if (!listRes.result.tools.some(t => t.name === "pp_self_review")) {
    throw new Error("Phase F: pp_self_review tool not registered");
  }
  for (const required of ["GOLDEN RULE #1", "GOLDEN RULE #2", "GOLDEN RULE #3", "expected_environment_url", "ParseJSON", "Category 5"]) {
    if (!instructions.includes(required)) {
      throw new Error(`Phase F instructions missing required term: ${required}`);
    }
  }
  console.log("OK Phase F pp_self_review tool + 6 GOLDEN RULES in instructions");

  // Phase F: solution_import tenant-safety guard refuses when expected_environment_url mismatches.
  send({ jsonrpc: "2.0", id: 60, method: "tools/call",
    params: { name: "solution_import", arguments: {
      path: "/tmp/nonexistent-test.zip",
      confirm: true,
      expected_environment_url: "https://this-tenant-cannot-possibly-exist.crm4.dynamics.com",
    } } });
  const r60 = await waitFor(60, 45_000);
  const r60text = r60.result?.content?.[0]?.text ?? "";
  if (!r60.result?.isError || !r60text.includes("TENANT-SAFETY")) {
    throw new Error(`solution_import expected_environment_url guard should block. Got:\n${r60text.slice(0, 300)}`);
  }
  console.log("OK solution_import refuses on expected_environment_url mismatch (Phase F)");

  // ---------- Phase D + E regressions (1.2.0) ----------
  const phaseDEExpected = [
    "canvas_pack_sync", "canvas_patch_property", "canvas_diff", "canvas_validate_yaml",
    "pp_token", "canvas_layer_inspect", "canvas_layer_remove",
  ];
  const missingDE = phaseDEExpected.filter(n => !listRes.result.tools.some(t => t.name === n));
  if (missingDE.length) throw new Error(`Phase D+E tools missing: ${missingDE.join(", ")}`);
  console.log(`OK Phase D+E tools registered (${phaseDEExpected.length} new)`);

  // E3: env_fetch pre-flight rejects `top='N'` before spawning pac.
  send({ jsonrpc: "2.0", id: 50, method: "tools/call",
    params: { name: "env_fetch", arguments: { xml: "<fetch top='3'><entity name='systemuser'></entity></fetch>" } } });
  const r50 = await waitFor(50, 10_000);
  if (!r50.result?.isError) throw new Error("env_fetch top= pre-flight should error");
  if (!(r50.result?.content?.[0]?.text ?? "").includes("count='N'")) {
    throw new Error("env_fetch top= pre-flight should suggest count='N' alternative");
  }
  console.log("OK env_fetch top='N' pre-flight rejects with actionable hint (E3)");

  // E3: env_fetch pre-flight rejects malformed (non-XML) inline content.
  send({ jsonrpc: "2.0", id: 51, method: "tools/call",
    params: { name: "env_fetch", arguments: { xml: "not xml at all" } } });
  const r51 = await waitFor(51, 10_000);
  if (!r51.result?.isError || !(r51.result?.content?.[0]?.text ?? "").includes("must start with")) {
    throw new Error("env_fetch should reject non-XML before spawning pac");
  }
  console.log("OK env_fetch rejects non-XML before spawning pac (E3)");

  // E7: canvas_layer_remove gated by confirm:true.
  send({ jsonrpc: "2.0", id: 52, method: "tools/call",
    params: { name: "canvas_layer_remove", arguments: { env_url: "https://x.crm.dynamics.com", component_id: "00000000-0000-0000-0000-000000000000", confirm: false } } });
  const r52 = await waitFor(52, 10_000);
  if (!r52.result?.isError || !(r52.result?.content?.[0]?.text ?? "").includes("BLOCKED")) {
    throw new Error("canvas_layer_remove must gate behind confirm:true");
  }
  console.log("OK canvas_layer_remove gated by confirm:true (E7)");

  // D: canvas_pack_sync gated by confirm:true (refuses to overwrite without explicit OK).
  send({ jsonrpc: "2.0", id: 53, method: "tools/call",
    params: { name: "canvas_pack_sync", arguments: { sources: "/tmp/nonexistent", output: "/tmp/x.msapp", confirm: false } } });
  const r53 = await waitFor(53, 10_000);
  if (!r53.result?.isError || !(r53.result?.content?.[0]?.text ?? "").includes("BLOCKED")) {
    throw new Error("canvas_pack_sync must gate behind confirm:true");
  }
  console.log("OK canvas_pack_sync gated by confirm:true (D2)");

  // ---------- Phase H (1.3.0): Power Pages gap closure ----------
  const phaseHExpected = [
    "pages_download_code_site", "pages_upload_code_site", "pages_migrate_datamodel",
    "pages_bootstrap_migrate", "pages_restart", "pages_site_status",
  ];
  const missingH = phaseHExpected.filter(n => !listRes.result.tools.some(t => t.name === n));
  if (missingH.length) throw new Error(`Phase H tools missing: ${missingH.join(", ")}`);
  console.log(`OK Phase H Power Pages tools registered (${phaseHExpected.length} new)`);

  // pages_restart must gate behind confirm:true (restart = brief outage).
  send({ jsonrpc: "2.0", id: 9601, method: "tools/call",
    params: { name: "pages_restart", arguments: { environment_id: "00000000-0000-0000-0000-000000000000", website_id: "11111111-1111-1111-1111-111111111111", confirm: false } } });
  const pr = await waitFor(9601, 15_000);
  if (!pr.result?.isError || !(pr.result?.content?.[0]?.text ?? "").includes("BLOCKED")) {
    throw new Error("pages_restart must gate behind confirm:true");
  }
  console.log("OK pages_restart gated by confirm:true (H2)");

  // pages_upload_code_site must gate behind confirm:true (destructive).
  send({ jsonrpc: "2.0", id: 9602, method: "tools/call",
    params: { name: "pages_upload_code_site", arguments: { root_path: "/tmp/x", confirm: false } } });
  const puc = await waitFor(9602, 15_000);
  if (!puc.result?.isError || !(puc.result?.content?.[0]?.text ?? "").includes("BLOCKED")) {
    throw new Error("pages_upload_code_site must gate behind confirm:true");
  }
  console.log("OK pages_upload_code_site gated by confirm:true (H1)");

  // pages_migrate_datamodel destructive mode (revert) must gate behind confirm:true;
  // check_status mode must NOT (it's read-only).
  send({ jsonrpc: "2.0", id: 9603, method: "tools/call",
    params: { name: "pages_migrate_datamodel", arguments: { website_id: "00000000-0000-0000-0000-000000000000", revert_to_standard: true, confirm: false } } });
  const pmd = await waitFor(9603, 15_000);
  if (!pmd.result?.isError || !(pmd.result?.content?.[0]?.text ?? "").includes("BLOCKED")) {
    throw new Error("pages_migrate_datamodel destructive mode (revert_to_standard) must gate behind confirm:true");
  }
  console.log("OK pages_migrate_datamodel destructive mode gated by confirm:true (H1)");

  // GOLDEN RULE #7 (Power Pages deploy recipe) embedded in instructions.
  for (const needle of ["GOLDEN RULE #7", "pages_restart", "server-side cache"]) {
    if (!instructions.includes(needle)) throw new Error(`Phase H instructions missing: ${needle}`);
  }
  console.log("OK SERVER_INSTRUCTIONS embeds Power Pages GOLDEN RULE #7 (H4)");

  console.log("\nALL SMOKE TESTS PASSED");
  child.kill();
  process.exit(0);
}

main().catch(err => {
  console.error("SMOKE TEST FAILED:", err.message);
  console.error("--- server stderr ---\n" + stderrBuf);
  child.kill();
  process.exit(1);
});
