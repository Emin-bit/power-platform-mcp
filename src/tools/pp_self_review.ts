// pp_self_review — mine ~/.power-platform-mcp/logs/ and produce a structured
// usage analysis. Designed for periodic self-reflection on what's working,
// what's failing, and what patterns suggest the next round of MCP improvements.
//
// Phase F (1.2.0). Driven by user request: "možeš li uzeti sve podatke od mene
// vrijedne analize, kako tražim rješenja, posebno kanvas workflow + auth/tenant".
//
// What this tool surfaces:
//   - Tool frequency (top 20)
//   - Failure rate per tool + recent stderr extracts (only available since Phase E
//     1.2.0 — earlier logs only carried exit codes)
//   - Slow ops (p95 over threshold)
//   - Canvas workflow patterns: download → unpack → edit → pack chain analysis
//   - Auth + tenant switching events (safety-critical)
//   - Solution_import events with active env at the time (tenant-safety audit)
//   - Week-over-week trend (failure rate, slow op count)
//   - Suggested improvements (heuristic — based on observed pain patterns)
//
// Design call: pure-Node, no Dataverse/network. Just reads local JSON-line log files
// and aggregates. Fast (~1s on 17 days of data).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolResult } from "../runner.js";
import { getLogDir } from "../logger.js";

interface LogEntry {
  file: string;
  ts: string;
  level?: string;
  msg?: string;
  // Free-form additional fields
  [key: string]: unknown;
}

function loadLogs(daysBack: number): LogEntry[] {
  const dir = getLogDir();
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const out: LogEntry[] = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith(".log")).sort()) {
    // Cheap date filter on filename (pac-mcp-YYYY-MM-DD.log).
    const dateMatch = f.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch) {
      const fDate = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00Z`).getTime();
      if (fDate < cutoff) continue;
    }
    try {
      const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
      for (const l of lines) {
        try { out.push({ file: f, ...JSON.parse(l) } as LogEntry); } catch { /* skip non-json line */ }
      }
    } catch { /* file unreadable, skip */ }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Pair "<tool>" start entries with "<tool> done" completion entries. */
interface ToolCallPair {
  tool: string;
  startTs: string;
  doneTs?: string;
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
  cmd?: string;
  /** Captured stderr from failed runs (Phase E 1.2.0+ only). */
  stderr?: string;
}

function pairToolCalls(entries: LogEntry[]): ToolCallPair[] {
  const pairs: ToolCallPair[] = [];
  const pending = new Map<string, LogEntry>();
  for (const e of entries) {
    if (!e.msg) continue;
    if (e.msg.endsWith(" done")) {
      const tool = e.msg.replace(/ done$/, "");
      const start = pending.get(tool);
      pairs.push({
        tool,
        startTs: start?.ts ?? e.ts,
        doneTs: e.ts,
        exitCode: e.exitCode as number | undefined,
        durationMs: e.durationMs as number | undefined,
        timedOut: e.timedOut as boolean | undefined,
        cmd: start?.cmd as string | undefined,
        stderr: e.stderr as string | undefined,
      });
      pending.delete(tool);
    } else {
      // Tool call started. If something was pending, drop it (server probably crashed).
      pending.set(e.msg, e);
    }
  }
  return pairs;
}

/** Group consecutive events within `gapMs` of each other into "sessions". */
function inferSessions(entries: LogEntry[], gapMs = 3600_000): LogEntry[][] {
  const out: LogEntry[][] = [];
  let cur: LogEntry[] = [];
  let prev: LogEntry | null = null;
  for (const e of entries) {
    if (prev && new Date(e.ts).getTime() - new Date(prev.ts).getTime() > gapMs) {
      if (cur.length) out.push(cur);
      cur = [];
    }
    cur.push(e);
    prev = e;
  }
  if (cur.length) out.push(cur);
  return out;
}

function pct(part: number, total: number): string {
  if (!total) return "0%";
  return ((part / total) * 100).toFixed(1) + "%";
}

function durationSummary(durations: number[]): { p50: number; p95: number; max: number } {
  if (!durations.length) return { p50: 0, p95: 0, max: 0 };
  const ds = [...durations].sort((a, b) => a - b);
  return {
    p50: ds[Math.floor(ds.length / 2)] ?? 0,
    p95: ds[Math.floor(ds.length * 0.95)] ?? 0,
    max: ds[ds.length - 1] ?? 0,
  };
}

export function registerSelfReview(server: McpServer) {
  server.tool(
    "pp_self_review",
    "Mine the local power-platform-mcp log directory (~/.power-platform-mcp/logs/) and produce a structured " +
    "usage report: tool frequency, failure rate (with stderr extracts since 1.2.0), slow operations, canvas " +
    "workflow patterns, auth/tenant switching audit, solution_import tenant safety, and week-over-week trends. " +
    "Use this periodically (weekly recommended) to see which MCP fix-es land, which tools still need work, and " +
    "which patterns in your own workflow could be automated. " +
    "Local-only — does NOT send any data anywhere. Phase F (1.2.0).",
    {
      days: z.number().int().positive().max(60).default(7).describe(
        "How many days back to analyze (default 7 = past week, max 60).",
      ),
      compare_with_prior_window: z.boolean().default(true).describe(
        "Include a week-over-week trend section comparing the most recent `days` window with the immediately prior one.",
      ),
      include_raw_failures: z.boolean().default(true).describe(
        "When true (default), include the stderr text from each failure (truncated). Set false for a compact summary.",
      ),
    },
    async ({ days, compare_with_prior_window, include_raw_failures }): Promise<ToolResult> => {
      const current = loadLogs(days);
      if (!current.length) {
        return {
          content: [{
            type: "text",
            text:
              `No log entries found in ${getLogDir()} for the past ${days} day(s).\n` +
              `If you've been using the MCP, check PAC_MCP_LOG_DIR env var override and the LOG_DIR ` +
              `default at ~/.power-platform-mcp/logs/.`,
          }],
        };
      }

      // ---- core aggregates ----
      const pairs = pairToolCalls(current);
      const sessions = inferSessions(current);
      const totalCalls = pairs.length;
      const failures = pairs.filter(p => p.exitCode !== undefined && p.exitCode !== 0);
      const timeouts = pairs.filter(p => p.timedOut);
      const failureRate = pct(failures.length, totalCalls);

      // ---- tool frequency + per-tool stats ----
      const byTool: Record<string, { calls: number; fails: number; tos: number; durations: number[] }> = {};
      for (const p of pairs) {
        byTool[p.tool] = byTool[p.tool] ?? { calls: 0, fails: 0, tos: 0, durations: [] };
        byTool[p.tool].calls++;
        if (p.exitCode !== undefined && p.exitCode !== 0) byTool[p.tool].fails++;
        if (p.timedOut) byTool[p.tool].tos++;
        if (p.durationMs != null) byTool[p.tool].durations.push(p.durationMs);
      }
      const toolRows = Object.entries(byTool).sort((a, b) => b[1].calls - a[1].calls);

      // ---- canvas workflow analysis ----
      const canvasPairs = pairs.filter(p => p.tool.startsWith("canvas_"));
      const canvasChainHints: string[] = [];
      // Detect chains: download → unpack → (pack | pack_sync) within 30min
      for (let i = 0; i < canvasPairs.length; i++) {
        const a = canvasPairs[i];
        if (a.tool !== "canvas_download") continue;
        const followups = canvasPairs.slice(i + 1, i + 10);
        const unp = followups.find(f => f.tool === "canvas_unpack");
        const pk = followups.find(f => f.tool === "canvas_pack" || f.tool === "canvas_pack_sync");
        if (unp && pk) {
          const total = new Date(pk.doneTs ?? pk.startTs).getTime() - new Date(a.startTs).getTime();
          canvasChainHints.push(
            `Full chain at ${a.startTs.slice(0, 19)}: download → unpack → ${pk.tool} (${Math.round(total / 1000)}s end-to-end)`,
          );
        } else if (unp && !pk) {
          canvasChainHints.push(
            `Incomplete chain at ${a.startTs.slice(0, 19)}: download → unpack BUT NO pack — may indicate the user gave up after edit failed.`,
          );
        }
      }

      // ---- auth + tenant switching ----
      const authSwitches: string[] = [];
      const entriesSorted = current; // already sorted by ts in loadLogs
      for (let i = 0; i < entriesSorted.length; i++) {
        const e = entriesSorted[i];
        if (e.msg === "auth_select" || e.msg === "env_select") {
          // Find the next destructive-y tool within 5min.
          const next = entriesSorted.slice(i + 1, i + 20).find(x =>
            typeof x.msg === "string" &&
            /^(solution_import|solution_export|env_(delete|reset|copy|backup|restore))$/.test(x.msg),
          );
          if (next) {
            const gap = new Date(next.ts).getTime() - new Date(e.ts).getTime();
            if (gap < 5 * 60_000) {
              const idx = (e.index ?? e.args ?? "?") as string;
              authSwitches.push(
                `${e.ts.slice(0, 19)} ${e.msg}(${typeof idx === "string" ? idx : JSON.stringify(idx)}) → ${next.msg} after ${Math.round(gap / 1000)}s`,
              );
            }
          }
        }
      }

      // ---- solution_import tenant-safety audit ----
      // For each solution_import, find the nearest prior whoami/env_who.
      const imports = entriesSorted.filter(e => e.msg === "solution_import");
      const importAudit: string[] = [];
      for (const imp of imports) {
        const impTs = new Date(imp.ts).getTime();
        let mostRecentContext: LogEntry | null = null;
        for (let i = entriesSorted.length - 1; i >= 0; i--) {
          const e = entriesSorted[i];
          if (new Date(e.ts).getTime() >= impTs) continue;
          // pacx_auth_ping is the PACX equivalent of `whoami` — counts as a context
          // verification step. Without this, users who verify via PACX get a false-alarm
          // "🔴 no whoami EVER PRECEDED THIS IMPORT" warning.
          if (e.msg === "whoami" || e.msg === "env_who" || e.msg === "pacx_auth_ping") {
            mostRecentContext = e;
            break;
          }
        }
        const gapMin = mostRecentContext
          ? Math.round((impTs - new Date(mostRecentContext.ts).getTime()) / 60_000)
          : Infinity;
        const cmd = (imp.cmd as string | undefined)?.slice(0, 100) ?? "";
        const cmdShort = cmd.length > 100 ? cmd.slice(0, 100) + "…" : cmd;
        const safetyTag =
          gapMin === Infinity ? "🔴 NO whoami/env_who EVER PRECEDED THIS IMPORT" :
          gapMin > 30 ? `🟡 last whoami was ${gapMin}min ago — stale (>30min)` :
          gapMin > 5 ? `🟡 last whoami was ${gapMin}min ago — okay but verify` :
          `🟢 whoami ${gapMin}min before`;
        importAudit.push(`${imp.ts.slice(0, 19)} ${safetyTag}  cmd: ${cmdShort}`);
      }

      // ---- failure stderr extracts ----
      const failureExtracts: string[] = [];
      if (include_raw_failures && failures.length) {
        const grouped: Record<string, { count: number; samples: string[] }> = {};
        for (const f of failures) {
          const key = f.tool;
          grouped[key] = grouped[key] ?? { count: 0, samples: [] };
          grouped[key].count++;
          if (f.stderr && grouped[key].samples.length < 3) {
            grouped[key].samples.push(`(${f.startTs.slice(0, 19)} exit=${f.exitCode}) ${f.stderr.slice(0, 240)}`);
          }
        }
        for (const [tool, info] of Object.entries(grouped).sort((a, b) => b[1].count - a[1].count)) {
          failureExtracts.push(`\n  ▸ ${tool} (${info.count} failure${info.count > 1 ? "s" : ""})`);
          if (info.samples.length === 0) {
            failureExtracts.push("      (no stderr captured — these failures predate the Phase E 1.2.0 logger fix)");
          } else {
            for (const s of info.samples) failureExtracts.push("      " + s);
          }
        }
      }

      // ---- week-over-week comparison ----
      let weekOverWeek = "";
      if (compare_with_prior_window) {
        const prior = loadLogs(days * 2).filter(e => {
          const ts = new Date(e.ts).getTime();
          const cutoffStart = Date.now() - days * 2 * 24 * 60 * 60 * 1000;
          const cutoffEnd = Date.now() - days * 24 * 60 * 60 * 1000;
          return ts >= cutoffStart && ts < cutoffEnd;
        });
        const priorPairs = pairToolCalls(prior);
        if (priorPairs.length) {
          const priorFails = priorPairs.filter(p => p.exitCode !== undefined && p.exitCode !== 0).length;
          const priorRate = (priorFails / priorPairs.length) * 100;
          const currRate = totalCalls ? (failures.length / totalCalls) * 100 : 0;
          const delta = currRate - priorRate;
          const arrow = Math.abs(delta) < 1 ? "→" : delta < 0 ? "↓" : "↑";
          weekOverWeek =
            `\n=== TREND (prior ${days}d → current ${days}d) ===\n` +
            `  Total calls:   ${priorPairs.length} → ${totalCalls} (${arrow})\n` +
            `  Failure rate:  ${priorRate.toFixed(1)}% → ${currRate.toFixed(1)}%  (Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp)\n`;
        }
      }

      // ---- suggestions (heuristic) ----
      const suggestions: string[] = [];
      for (const [tool, s] of toolRows) {
        if (s.calls >= 5 && s.fails / s.calls > 0.20) {
          suggestions.push(`▸ ${tool} has ${pct(s.fails, s.calls)} failure rate over ${s.calls} calls — needs investigation. Review the stderr extracts above.`);
        }
        const ds = durationSummary(s.durations);
        if (s.calls >= 3 && ds.p95 > 60_000 && tool !== "solution_import" && !tool.startsWith("job_")) {
          suggestions.push(`▸ ${tool} p95 = ${(ds.p95 / 1000).toFixed(1)}s, past Claude Desktop's 60s MCP transport timeout. If it doesn't already expose background:true, add it.`);
        }
      }
      if (imports.length && importAudit.some(s => s.includes("🔴") || s.includes("🟡"))) {
        suggestions.push(`▸ Some solution_import calls had stale/missing whoami context — see TENANT-SAFETY AUDIT below. Consider running whoami immediately before every import.`);
      }
      if (canvasChainHints.some(h => h.includes("Incomplete"))) {
        suggestions.push(`▸ Some canvas workflows ended at canvas_unpack without a pack — possibly because pack_sync wasn't yet available (pre-1.2.0). Worth retrying with canvas_pack_sync now.`);
      }

      // ---- build the report ----
      const lines: string[] = [];
      lines.push(`# pp_self_review — last ${days} day(s)`);
      lines.push(`Generated ${new Date().toISOString()} from ${current.length} log entries across ${sessions.length} session(s).`);
      lines.push("");
      lines.push(`=== HEADLINE ===`);
      lines.push(`  Tool calls completed:   ${totalCalls}`);
      lines.push(`  Failures (exit ≠ 0):    ${failures.length} (${failureRate})`);
      lines.push(`  Timeouts:               ${timeouts.length}`);
      lines.push(`  Sessions inferred:      ${sessions.length}  (avg ${Math.round(current.length / sessions.length)} events/session)`);

      lines.push(weekOverWeek);

      lines.push("=== TOP 15 TOOLS BY FREQUENCY ===");
      lines.push("  calls  fails  to    p50      p95     tool");
      for (const [tool, s] of toolRows.slice(0, 15)) {
        const ds = durationSummary(s.durations);
        lines.push(
          "  " + String(s.calls).padStart(5) +
          "  " + String(s.fails).padStart(5) +
          "  " + String(s.tos).padStart(2) +
          "  " + (ds.p50 / 1000).toFixed(1).padStart(7) + "s" +
          "  " + (ds.p95 / 1000).toFixed(1).padStart(6) + "s" +
          "  " + tool,
        );
      }
      lines.push("");

      if (failureExtracts.length) {
        lines.push("=== FAILURE STDERR EXTRACTS (since Phase E 1.2.0) ===");
        lines.push(...failureExtracts);
        lines.push("");
      }

      lines.push("=== CANVAS WORKFLOW ANALYSIS ===");
      if (canvasPairs.length === 0) {
        lines.push("  No canvas_* events in this window.");
      } else {
        lines.push(`  Total canvas_* calls: ${canvasPairs.length}`);
        for (const h of canvasChainHints.slice(0, 10)) lines.push("  " + h);
        if (canvasChainHints.length > 10) lines.push(`  … and ${canvasChainHints.length - 10} more`);
      }
      lines.push("");

      lines.push("=== AUTH / TENANT SWITCHING (safety-relevant) ===");
      if (authSwitches.length === 0) {
        lines.push("  No auth_select or env_select → destructive-op patterns in this window. 🟢");
      } else {
        for (const a of authSwitches.slice(0, 10)) lines.push("  " + a);
      }
      lines.push("");

      lines.push("=== SOLUTION_IMPORT TENANT-SAFETY AUDIT ===");
      if (imports.length === 0) {
        lines.push("  No solution_import events in this window.");
      } else {
        lines.push(`  Total imports: ${imports.length}`);
        for (const a of importAudit.slice(0, 10)) lines.push("  " + a);
        if (importAudit.length > 10) lines.push(`  … and ${importAudit.length - 10} more`);
      }
      lines.push("");

      lines.push("=== SUGGESTIONS ===");
      if (suggestions.length === 0) {
        lines.push("  Nothing pops out from this window. 🟢");
      } else {
        for (const s of suggestions) lines.push("  " + s);
      }
      lines.push("");

      lines.push("---");
      lines.push("Privacy: this report was generated locally from ~/.power-platform-mcp/logs/ only. ");
      lines.push("The log files already have homedir + OS username auto-redacted (since 1.2.0), so this output ");
      lines.push("is safe to copy into a chat or GitHub issue.");

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
