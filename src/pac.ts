import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PacBinary = "pac" | "pacx";

export interface RunOptions {
  binary: PacBinary;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

const SECRET_FLAG_NAMES = [
  "--clientSecret",
  "--client-secret",
  "--cs",
  "--secret",
  "--password",
  "--certificatePassword",
  "--certificate-password",
  "--cert-password",
];

function getPlatformBinPaths(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE ?? home;
    const localAppData = process.env.LOCALAPPDATA ?? join(userProfile, "AppData", "Local");
    return [
      join(userProfile, ".dotnet", "tools"),
      join(localAppData, "Microsoft", "PowerAppsCli"),
    ];
  }
  return [
    join(home, ".dotnet", "tools"),
    "/usr/local/share/dotnet",
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

export function getEffectivePath(): string {
  const sep = process.platform === "win32" ? ";" : ":";
  const existing = (process.env.PATH ?? "").split(sep).filter(Boolean);
  const additions = getPlatformBinPaths().filter(p => p && !existing.includes(p));
  return [...additions, ...existing].join(sep);
}

export function resolveBinary(name: PacBinary): string {
  const overrideKey = name === "pac" ? "PAC_BIN_PATH" : "PACX_BIN_PATH";
  const override = process.env[overrideKey];
  if (override && existsSync(override)) return override;
  return name;
}

export function maskArgs(args: string[]): string[] {
  const masked: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eqIdx = a.indexOf("=");
    if (eqIdx > 0) {
      const flag = a.slice(0, eqIdx);
      if (SECRET_FLAG_NAMES.includes(flag)) {
        masked.push(`${flag}=***REDACTED***`);
        continue;
      }
    }
    masked.push(a);
    if (SECRET_FLAG_NAMES.includes(a) && i + 1 < args.length) {
      masked.push("***REDACTED***");
      i++;
    }
  }
  return masked;
}

export function maskInOutput(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("***REDACTED***");
  }
  return out;
}

export async function runPac(opts: RunOptions): Promise<RunResult> {
  const { binary, args, cwd, timeoutMs = 600_000, env: extraEnv } = opts;
  const bin = resolveBinary(binary);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    PATH: getEffectivePath(),
  };

  const start = Date.now();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env: childEnv, shell: false });
    } catch (err) {
      reject(new Error(`Failed to spawn '${bin}': ${(err as Error).message}. Is ${binary} installed and on PATH? Try setting ${binary === "pac" ? "PAC_BIN_PATH" : "PACX_BIN_PATH"} to the absolute binary path.`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5_000);
    }, timeoutMs);

    child.stdout?.on("data", d => { stdout += d.toString(); });
    child.stderr?.on("data", d => { stderr += d.toString(); });

    child.on("error", err => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(new Error(`'${bin}' not found. Install Power Platform CLI (\`dotnet tool install --global Microsoft.PowerApps.CLI.Tool\`) or set ${binary === "pac" ? "PAC_BIN_PATH" : "PACX_BIN_PATH"} env var to the binary path. Looked on PATH: ${getEffectivePath()}`));
      } else {
        reject(new Error(`Failed to spawn '${bin}': ${err.message}`));
      }
    });

    child.on("close", code => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
  });
}
