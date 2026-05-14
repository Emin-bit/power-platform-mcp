import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const LOG_DIR = process.env.PAC_MCP_LOG_DIR ?? join(homedir(), ".power-platform-mcp", "logs");

let dirEnsured = false;
function ensureLogDir() {
  if (dirEnsured) return;
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  dirEnsured = true;
}

function todayFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOG_DIR, `pac-mcp-${date}.log`);
}

export type LogLevel = "info" | "warn" | "error" | "debug";

function isVerbose(): boolean {
  const v = (process.env.PAC_MCP_VERBOSE ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

// Privacy redaction (Phase E E1): pac/pacx commands often include filesystem paths
// (--path /Users/<name>/Desktop/...) that contain the OS username. A user who shares
// their log file for support shouldn't have to scrub paths by hand. The redaction
// collapses homedir to `~` and the bare username to `<user>` (case-insensitive,
// minimum 3-char username to avoid mangling short generic names like "ed").
//
// Computed once at module load — both `homedir()` and `userInfo().username` are
// stable for the process lifetime.
const HOME = homedir();
let USERNAME: string | undefined;
try { USERNAME = userInfo().username; } catch { USERNAME = undefined; }
const USERNAME_RE: RegExp | null =
  USERNAME && USERNAME.length >= 3
    ? new RegExp(USERNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
    : null;

function redactPersonal(value: unknown): unknown {
  if (typeof value === "string") {
    let out = value;
    if (HOME && out.includes(HOME)) out = out.split(HOME).join("~");
    if (USERNAME_RE) out = out.replace(USERNAME_RE, "<user>");
    return out;
  }
  if (Array.isArray(value)) return value.map(redactPersonal);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = redactPersonal(v);
    return out;
  }
  return value;
}

export function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  try {
    if (level === "debug" && !isVerbose()) return;
    ensureLogDir();
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: redactPersonal(message),
      ...(fields ? (redactPersonal(fields) as Record<string, unknown>) : {}),
    };
    appendFileSync(todayFile(), JSON.stringify(entry) + "\n");
    if (isVerbose()) {
      process.stderr.write(`[pac-mcp] ${entry.ts} ${level} ${entry.msg} ${fields ? JSON.stringify(redactPersonal(fields)) : ""}\n`);
    }
  } catch {
    // never throw from logger
  }
}

export function getLogDir(): string {
  return LOG_DIR;
}

/**
 * Truncate-and-sanitize helper for log fields. Use when logging stderr/stdout —
 * we want enough to debug but not a multi-MB blob in the daily log file.
 */
export function logTruncate(s: string | undefined, maxChars = 500): string | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars) + ` … (+${trimmed.length - maxChars} chars)`;
}
