// Shared setup logic — used both by the CLI subcommand (`npx power-platform-mcp setup`)
// and by the MCP tools (preflight, setup_install_pac_tools).
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { getEffectivePath } from "./pac.js";

export const PAC_TOOL_PACKAGE = "microsoft.powerapps.cli.tool";
export const PACX_TOOL_PACKAGE = "greg.xrm.command";

export type ProbeStatus = "ok" | "missing" | "error";

export interface Probe {
  name: string;
  status: ProbeStatus;
  version?: string;
  detail?: string;
  fix?: string;
}

interface RunOpts {
  cmd: string;
  args: string[];
  timeoutMs?: number;
}

interface RunRes {
  stdout: string;
  stderr: string;
  exitCode: number;
  errorCode?: string;
}

function runOnce(opts: RunOpts): Promise<RunRes> {
  return new Promise(resolve => {
    const start = Date.now();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(opts.cmd, opts.args, {
        env: { ...process.env, PATH: getEffectivePath() },
        shell: false,
      });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: (err as Error).message,
        exitCode: -1,
        errorCode: (err as NodeJS.ErrnoException).code,
      });
      return;
    }
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", d => { stdout += d.toString(); });
    child.stderr?.on("data", d => { stderr += d.toString(); });
    child.on("error", err => {
      clearTimeout(t);
      resolve({
        stdout, stderr,
        exitCode: -1,
        errorCode: (err as NodeJS.ErrnoException).code,
      });
    });
    child.on("close", code => {
      clearTimeout(t);
      void start; void timedOut;
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function probeBinary(cmd: string, args: string[], extractVersion: (out: string) => string | undefined): Promise<Probe & { rawOutput?: string }> {
  const r = await runOnce({ cmd, args, timeoutMs: 15_000 });
  if (r.errorCode === "ENOENT") {
    return { name: cmd, status: "missing", detail: "not found on PATH" };
  }
  if (r.exitCode !== 0) {
    return { name: cmd, status: "error", detail: r.stderr.trim() || `exit ${r.exitCode}` };
  }
  const out = r.stdout || r.stderr;
  return { name: cmd, status: "ok", version: extractVersion(out), rawOutput: out };
}

// ---------- Probes ----------

export async function probeNode(): Promise<Probe> {
  return {
    name: "node",
    status: "ok",
    version: process.versions.node,
    detail: parseFloat(process.versions.node) < 18 ? "WARNING: Node 18+ recommended" : undefined,
  };
}

export async function probeDotnet(): Promise<Probe> {
  const p = await probeBinary("dotnet", ["--version"], out => out.trim().split("\n").pop()?.trim());
  if (p.status === "missing") {
    return {
      ...p,
      fix: "Install .NET SDK 6+ from https://dotnet.microsoft.com/download . MCP cannot install this for you.",
    };
  }
  return p;
}

export async function probePac(): Promise<Probe> {
  // PAC quirk: `pac --version` exits 1 (PAC parses --version as an unknown subcommand
  // and errors), but DOES print the version banner. Extract from stdout regardless of
  // exit code — version is what we care about, not how PAC chooses to exit.
  const r = await runOnce({ cmd: "pac", args: ["--version"], timeoutMs: 15_000 });
  if (r.errorCode === "ENOENT") {
    return {
      name: "pac",
      status: "missing",
      detail: "not found on PATH",
      fix: `dotnet tool install --global ${PAC_TOOL_PACKAGE}`,
    };
  }
  const out = r.stdout || r.stderr;
  const m = out.match(/Version:\s*([^\s+]+)/i);
  if (m) return { name: "pac", status: "ok", version: m[1] };
  return {
    name: "pac",
    status: "error",
    detail: (out.trim().split("\n").pop() || `exit ${r.exitCode}`).slice(0, 100),
    fix: `dotnet tool install --global ${PAC_TOOL_PACKAGE}`,
  };
}

export async function probePacx(): Promise<Probe> {
  // PACX prints "Version <X>" inside its banner. Same robustness as probePac —
  // accept the version even if exit code is non-zero.
  const r = await runOnce({ cmd: "pacx", args: ["--version"], timeoutMs: 15_000 });
  if (r.errorCode === "ENOENT") {
    return {
      name: "pacx",
      status: "missing",
      detail: "not found on PATH",
      fix: `dotnet tool install --global ${PACX_TOOL_PACKAGE}`,
    };
  }
  const out = r.stdout || r.stderr;
  const m = out.match(/Version\s+([^\s]+)/i);
  if (m) return { name: "pacx", status: "ok", version: m[1] };
  return {
    name: "pacx",
    status: "error",
    detail: (out.trim().split("\n").pop() || `exit ${r.exitCode}`).slice(0, 100),
    fix: `dotnet tool install --global ${PACX_TOOL_PACKAGE}`,
  };
}

export async function probePacAuth(): Promise<Probe> {
  const r = await runOnce({ cmd: "pac", args: ["auth", "list"], timeoutMs: 15_000 });
  if (r.errorCode === "ENOENT") {
    return { name: "pac auth", status: "missing", detail: "pac not installed" };
  }
  // PAC prints "No profiles were found on this computer..." or a table
  if (r.stdout.toLowerCase().includes("no profiles") || (!r.stdout.includes("[") && r.exitCode !== 0)) {
    return {
      name: "pac auth",
      status: "missing",
      detail: "no PAC auth profiles configured",
      fix: 'pac auth create --deviceCode --name myorg   # or use auth_create_* MCP tools',
    };
  }
  // Count profiles
  const profileLines = r.stdout.split("\n").filter(l => /^\[\d+\]/.test(l));
  const activeLine = profileLines.find(l => l.includes(" * "));
  return {
    name: "pac auth",
    status: "ok",
    detail: `${profileLines.length} profile(s)${activeLine ? `, active: ${activeLine.trim().slice(0, 80)}` : ""}`,
  };
}

export async function probePacxAuth(): Promise<Probe> {
  const r = await runOnce({ cmd: "pacx", args: ["auth", "list"], timeoutMs: 15_000 });
  if (r.errorCode === "ENOENT") {
    return { name: "pacx auth", status: "missing", detail: "pacx not installed" };
  }
  if (r.exitCode !== 0 || r.stdout.toLowerCase().includes("no authentication")) {
    return {
      name: "pacx auth",
      status: "missing",
      detail: "no PACX auth profiles (separate from PAC profile store)",
      fix: 'Use pacx_auth_create MCP tool, or run: pacx auth create --name myorg --environment <url>',
    };
  }
  return { name: "pacx auth", status: "ok", detail: "configured" };
}

export interface PreflightReport {
  probes: Probe[];
  allOk: boolean;
  summary: string;
}

export async function runPreflight(): Promise<PreflightReport> {
  const probes = await Promise.all([
    probeNode(),
    probeDotnet(),
    probePac(),
    probePacx(),
    probePacAuth(),
    probePacxAuth(),
  ]);
  const allOk = probes.every(p => p.status === "ok");
  const summary = probes
    .map(p => {
      const icon = p.status === "ok" ? "✅" : p.status === "missing" ? "❌" : "⚠️";
      const ver = p.version ? ` v${p.version}` : "";
      const det = p.detail ? ` — ${p.detail}` : "";
      const fix = p.fix ? `\n      fix: ${p.fix}` : "";
      return `${icon} ${p.name}${ver}${det}${fix}`;
    })
    .join("\n");
  return { probes, allOk, summary };
}

// ---------- Install actions ----------

export interface InstallResult {
  package: string;
  command: string;
  exitCode: number;
  alreadyInstalled: boolean;
  stdout: string;
  stderr: string;
}

export interface PrereqGateResult {
  ok: boolean;
  node: Probe;
  dotnet: Probe;
  blockers: string[]; // human-readable reasons we can't proceed
}

/**
 * Mandatory prerequisite check that MUST pass before any install attempt.
 * Node and .NET SDK are NOT auto-installable — user must install them via OS
 * package manager / installer. This gate is read-only and short.
 */
export async function checkMandatoryPrereqs(): Promise<PrereqGateResult> {
  const [node, dotnet] = await Promise.all([probeNode(), probeDotnet()]);
  const blockers: string[] = [];

  // Node check — if we got here we are obviously running on Node, but warn if version is too old
  if (node.detail?.includes("WARNING")) {
    blockers.push(`Node.js ${node.version} is older than recommended 18+. Upgrade Node from https://nodejs.org/ (this MCP cannot do it for you).`);
  }
  if (dotnet.status !== "ok") {
    blockers.push(`.NET SDK is ${dotnet.status === "missing" ? "missing" : "broken"}. Install .NET SDK 6+ from https://dotnet.microsoft.com/download (this MCP cannot do it for you — different per OS, may require admin).`);
  }

  return { ok: blockers.length === 0, node, dotnet, blockers };
}

async function installOrUpdate(packageId: string, alreadyOk: boolean): Promise<InstallResult> {
  if (alreadyOk) {
    return {
      package: packageId,
      command: `dotnet tool install --global ${packageId}`,
      exitCode: 0,
      alreadyInstalled: true,
      stdout: `${packageId} already installed; skipping.`,
      stderr: "",
    };
  }
  const r = await runOnce({
    cmd: "dotnet",
    args: ["tool", "install", "--global", packageId],
    timeoutMs: 5 * 60_000,
  });
  return {
    package: packageId,
    command: `dotnet tool install --global ${packageId}`,
    exitCode: r.exitCode,
    alreadyInstalled: false,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

export async function installPacTools(): Promise<{
  prereqs: PrereqGateResult;
  pac?: InstallResult;
  pacx?: InstallResult;
}> {
  // STEP 1 — mandatory prereqs (Node + .NET). If missing → abort install.
  const prereqs = await checkMandatoryPrereqs();
  if (!prereqs.ok) return { prereqs };

  // STEP 2 — auto-installable tools (pac + pacx).
  const pacProbe = await probePac();
  const pacxProbe = await probePacx();
  const pac = await installOrUpdate(PAC_TOOL_PACKAGE, pacProbe.status === "ok");
  const pacx = await installOrUpdate(PACX_TOOL_PACKAGE, pacxProbe.status === "ok");
  return { prereqs, pac, pacx };
}

// ---------- CLI mode ----------

export async function runSetupCli(): Promise<void> {
  const out = (s: string) => process.stdout.write(s + "\n");
  const probeIcon = (p: Probe) => p.status === "ok" ? "✅" : p.status === "missing" ? "❌" : "⚠️";

  out("══════════════════════════════════════════════════════════════");
  out("  Power Platform MCP — interactive setup");
  out("══════════════════════════════════════════════════════════════\n");

  // ─── PHASE 1 — MANDATORY PREREQUISITES (cannot be auto-installed) ───
  out("Phase 1 — Mandatory prerequisites (Node.js + .NET SDK)");
  out("─────────────────────────────────────────────────────────");
  out("These cannot be auto-installed by this script — they require OS-level");
  out("installation, often with admin rights. We MUST verify them before doing");
  out("anything else.\n");

  const prereqs = await checkMandatoryPrereqs();
  out(`  ${probeIcon(prereqs.node)} Node.js${prereqs.node.version ? ` v${prereqs.node.version}` : ""}${prereqs.node.detail ? ` — ${prereqs.node.detail}` : ""}`);
  out(`  ${probeIcon(prereqs.dotnet)} .NET SDK${prereqs.dotnet.version ? ` v${prereqs.dotnet.version}` : ""}${prereqs.dotnet.detail ? ` — ${prereqs.dotnet.detail}` : ""}`);
  out("");

  if (!prereqs.ok) {
    out("✗ Mandatory prerequisites are not satisfied. Cannot proceed.\n");
    for (const reason of prereqs.blockers) out("  • " + reason);
    out("\nFix the items above, then re-run: npx power-platform-mcp setup\n");
    process.exit(1);
  }
  out("✓ Mandatory prerequisites OK.\n");

  // ─── PHASE 2 — AUTO-INSTALL pac + pacx ───────────────────────────────
  out("Phase 2 — Auto-install pac and pacx (.NET global tools)");
  out("─────────────────────────────────────────────────────────");
  out("These ARE auto-installable via `dotnet tool install --global`. Already-");
  out("installed packages are detected and skipped (no reinstall, no overwrite).\n");

  const res = await installPacTools();
  if (!res.prereqs.ok) {
    // Should never happen — we just verified above. But race condition safety.
    out("✗ Prerequisites disappeared between phases — aborting.\n");
    process.exit(1);
  }
  for (const r of [res.pac, res.pacx]) {
    if (!r) continue;
    if (r.alreadyInstalled) {
      out(`  ✓ ${r.package}: already installed (skipped)`);
    } else if (r.exitCode === 0) {
      out(`  ✓ ${r.package}: newly installed`);
    } else {
      out(`  ✗ ${r.package}: install failed (exit ${r.exitCode})`);
      if (r.stderr.trim()) out(`    last stderr line: ${r.stderr.trim().split("\n").pop()}`);
    }
  }
  out("");

  // ─── PHASE 3 — VERIFY (full preflight) ───────────────────────────────
  out("Phase 3 — Verify final state (full preflight)");
  out("─────────────────────────────────────────────────────────");
  const post = await runPreflight();
  out(post.summary + "\n");

  // ─── PHASE 4 — Auth + Claude config (manual) ─────────────────────────
  out("Phase 4 — Manual steps (auth + Claude Desktop config)");
  out("─────────────────────────────────────────────────────────");
  out("These steps cannot be automated — they require browser interaction or");
  out("editing your local Claude Desktop config file.\n");
  out("  1. Authenticate to Power Platform (one-time, interactive in browser):");
  out("       pac auth create --deviceCode --name myorg\n");
  out("  2. Add this block to your Claude Desktop config:");
  const home = homedir();
  const cfgPath = process.platform === "darwin"
    ? `${home}/Library/Application Support/Claude/claude_desktop_config.json`
    : process.platform === "win32"
      ? `%APPDATA%\\Claude\\claude_desktop_config.json`
      : `${home}/.config/Claude/claude_desktop_config.json`;
  out(`     (config file: ${cfgPath})\n`);
  const snippet = JSON.stringify({
    mcpServers: {
      "power-platform": {
        command: "npx",
        args: ["-y", "power-platform-mcp"],
        env: {
          PAC_MCP_SAFE_MODE: "on",
          MCP_TIMEOUT: "600000",
        },
      },
    },
  }, null, 2);
  for (const line of snippet.split("\n")) out("       " + line);
  out("\n  3. Restart Claude Desktop (Cmd+Q on macOS, then reopen).");
  out("  4. In a new chat, ask: \"run preflight\" — it should show all green.\n");

  out("══════════════════════════════════════════════════════════════");
  out(post.allOk
    ? "  Setup complete. After Phase 4 (auth + config + restart), MCP is ready."
    : "  Setup partially complete. Address the items above (likely auth — that's expected if you haven't logged in yet).");
  out("══════════════════════════════════════════════════════════════");
}
