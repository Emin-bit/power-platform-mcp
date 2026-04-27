import { runPac, maskArgs, type RunOptions, type PacBinary } from "./pac.js";
import { log } from "./logger.js";

export interface ToolContent {
  type: "text";
  text: string;
  [x: string]: unknown;
}

export interface ToolResult {
  isError?: boolean;
  content: ToolContent[];
  [x: string]: unknown;
}

export interface RunAsToolOptions {
  toolName: string;
  binary: PacBinary;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  // Optional follow-up text appended to the response (e.g. "Next: call solution_publish to make changes live")
  hint?: string;
  // Optional secrets to redact from the textual output (in addition to log redaction)
  redact?: string[];
}

function maskInText(text: string, secrets?: string[]): string {
  if (!secrets || secrets.length === 0) return text;
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("***REDACTED***");
  }
  return out;
}

export async function runAsTool(opts: RunAsToolOptions): Promise<ToolResult> {
  const { toolName, binary, args, cwd, timeoutMs, hint, redact } = opts;
  const maskedCmd = `${binary} ${maskArgs(args).join(" ")}`;
  log("info", toolName, { cmd: maskedCmd });

  try {
    const r = await runPac({ binary, args, cwd, timeoutMs });
    log("info", `${toolName} done`, {
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
    });

    const stdout = r.stdout.trimEnd();
    const stderr = r.stderr.trimEnd();
    const header = `$ ${maskedCmd}\nexit=${r.exitCode} duration=${r.durationMs}ms${r.timedOut ? " [TIMED OUT]" : ""}`;

    const parts: string[] = [header];
    if (stdout) parts.push(stdout);
    if (stderr && stderr !== stdout) parts.push(`--- stderr ---\n${stderr}`);
    if (!stdout && !stderr) parts.push("(no output)");
    if (hint && r.exitCode === 0) parts.push(`--- hint ---\n${hint}`);

    return {
      isError: r.exitCode !== 0,
      content: [{ type: "text", text: maskInText(parts.join("\n\n"), redact) }],
    };
  } catch (err) {
    const msg = (err as Error).message;
    log("error", `${toolName} failed`, { error: msg });
    return {
      isError: true,
      content: [{ type: "text", text: msg }],
    };
  }
}
