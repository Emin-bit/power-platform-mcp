import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runPac, maskArgs, type RunResult, type PacBinary } from "../pac.js";
import { isDestructive, safeModeEnabled } from "../safety.js";
import { parseShellArgs } from "../shell.js";
import { backgroundResult } from "../jobs.js";
import { log, logTruncate } from "../logger.js";

function formatResult(binary: string, argv: string[], r: RunResult): string {
  const header = `$ ${binary} ${maskArgs(argv).join(" ")}\nexit=${r.exitCode} duration=${r.durationMs}ms${r.timedOut ? " [TIMED OUT]" : ""}`;
  const parts = [header];
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`);
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push("(no output)");
  return parts.join("\n\n");
}

export function registerPassthrough(server: McpServer) {
  for (const binary of ["pac", "pacx"] as const satisfies readonly PacBinary[]) {
    server.tool(
      `${binary}_run`,
      `Run an arbitrary '${binary}' CLI command. Pass the arguments as a single string in 'args' exactly as you would type after '${binary}' on the shell. ` +
      `Example: args="solution list". ` +
      (binary === "pac"
        ? `⚠️ For Dataverse TABLE / COLUMN / OPTIONSET / KEY / RELATIONSHIP operations, use pacx_run or the typed pacx_table_* / pacx_column_* tools instead — PAC does NOT support these directly. ` +
          `For direct in-env solution creation, use pacx_solution_create. `
        : "") +
      `DESTRUCTIVE operations (delete/reset/restore/wipe, --force/--overwrite, solution import, env copy) require confirm=true when safe-mode is on (default). ` +
      `For commands that may exceed Claude Desktop's ~60s MCP transport timeout (PACX table/column ops, solution import, large export, etc.), set background=true: returns a job id immediately, track via job_status / job_wait / job_cancel. ` +
      `Default sync timeout 600s, max 1800s. Use this for any '${binary}' subcommand not covered by a dedicated tool, including new commands added in future ${binary} releases.`,
      {
        args: z.string().describe(`Arguments to '${binary}', e.g. "env list" or "solution export --path ./out.zip --name MySol"`),
        confirm: z.boolean().optional().describe("Set true to authorize destructive operations. Required when safe-mode is on."),
        cwd: z.string().optional().describe("Working directory for the command (absolute path recommended)"),
        timeout_seconds: z.number().int().positive().max(1800).optional().describe("Sync timeout override (default 600s, max 1800s). Ignored when background=true."),
        background: z.boolean().default(false).describe("Fire-and-forget: returns a job id immediately, bypassing Claude Desktop's MCP transport timeout. Track via job_* tools."),
      },
      async ({ args, confirm, cwd, timeout_seconds, background }) => {
        let argv: string[];
        try {
          argv = parseShellArgs(args);
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Argument parse error: ${(err as Error).message}` }],
          };
        }
        if (argv.length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: `Empty args. Pass at least a subcommand, e.g. args="help" or args="env list".` }],
          };
        }

        const danger = isDestructive(argv);
        if (danger.destructive && safeModeEnabled() && !confirm) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: `BLOCKED: ${danger.reason}.\n` +
                `Re-call this tool with confirm=true to proceed.\n` +
                `Before confirming, you should call 'whoami' to verify the active tenant/environment.\n` +
                `To disable safe-mode globally (NOT recommended), set env PAC_MCP_SAFE_MODE=off in the MCP server config.`,
            }],
          };
        }

        log("info", `${binary}_run`, {
          args: maskArgs(argv).join(" "),
          confirm: !!confirm,
          destructive: danger.destructive,
          background,
        });

        if (background) return backgroundResult(`${binary}_run`, binary, argv, cwd);

        try {
          const result = await runPac({
            binary,
            args: argv,
            cwd,
            timeoutMs: (timeout_seconds ?? 600) * 1000,
          });

          // E2 fix: capture stderr at error-level when the command actually fails, so
          // post-hoc log analysis can answer "WHY did pacx_run exit 255 this morning?"
          // rather than just "exit code was 255". The user's May-12 log-mining session
          // surfaced that 44% of pacx_run calls failed with exit 255 and zero diagnostic
          // info in the log — fixing here.
          const isFailure = result.exitCode !== 0 || result.timedOut;
          log(isFailure ? "error" : "info", `${binary}_run done`, {
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            ...(isFailure ? {
              stderr: logTruncate(result.stderr),
              stdoutTail: result.stderr.trim() ? undefined : logTruncate(result.stdout),
            } : {}),
          });

          return {
            isError: result.exitCode !== 0,
            content: [{ type: "text", text: formatResult(binary, argv, result) }],
          };
        } catch (err) {
          log("error", `${binary}_run failed`, { error: String(err) });
          return {
            isError: true,
            content: [{ type: "text", text: (err as Error).message }],
          };
        }
      }
    );
  }
}
