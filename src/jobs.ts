import { spawn, ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getEffectivePath, resolveBinary, maskArgs, type PacBinary } from "./pac.js";
import { log } from "./logger.js";

export type JobState = "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  toolName: string;
  binary: PacBinary;
  args: string[];
  state: JobState;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  cwd?: string;
  truncatedStdout?: boolean;
  truncatedStderr?: boolean;
}

interface InternalJob extends Job {
  child?: ChildProcess;
}

const jobs = new Map<string, InternalJob>();
const MAX_OUTPUT_BYTES = 200_000; // 200KB per stream

function appendCapped(current: string, chunk: string, cap: number): { value: string; truncated: boolean } {
  if (current.length >= cap) return { value: current, truncated: true };
  const remaining = cap - current.length;
  if (chunk.length <= remaining) return { value: current + chunk, truncated: false };
  return { value: current + chunk.slice(0, remaining), truncated: true };
}

export interface StartJobOptions {
  toolName: string;
  binary: PacBinary;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export function startJob(opts: StartJobOptions): Job {
  const id = randomBytes(4).toString("hex");
  const bin = resolveBinary(opts.binary);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    PATH: getEffectivePath(),
  };

  const job: InternalJob = {
    id,
    toolName: opts.toolName,
    binary: opts.binary,
    args: opts.args,
    state: "running",
    startedAt: Date.now(),
    stdout: "",
    stderr: "",
    cwd: opts.cwd,
  };

  let child: ChildProcess;
  try {
    child = spawn(bin, opts.args, {
      cwd: opts.cwd,
      env: childEnv,
      shell: false,
    });
    job.child = child;
  } catch (err) {
    job.state = "failed";
    job.endedAt = Date.now();
    job.stderr = `spawn error: ${(err as Error).message}`;
    jobs.set(id, job);
    log("error", `job ${id} spawn error`, { error: (err as Error).message });
    return stripChild(job);
  }

  child.stdout?.on("data", (d: Buffer) => {
    const r = appendCapped(job.stdout, d.toString(), MAX_OUTPUT_BYTES);
    job.stdout = r.value;
    if (r.truncated) job.truncatedStdout = true;
  });
  child.stderr?.on("data", (d: Buffer) => {
    const r = appendCapped(job.stderr, d.toString(), MAX_OUTPUT_BYTES);
    job.stderr = r.value;
    if (r.truncated) job.truncatedStderr = true;
  });

  child.on("error", err => {
    if (job.state !== "running") return;
    job.state = "failed";
    job.endedAt = Date.now();
    job.stderr += `\n[spawn error] ${err.message}`;
    log("error", `job ${id} runtime error`, { error: err.message });
  });

  child.on("close", (code, signal) => {
    if (job.state === "cancelled") {
      job.endedAt = job.endedAt ?? Date.now();
      job.exitCode = code ?? -1;
      job.signal = signal;
      log("info", `job ${id} closed after cancel`, { code, signal });
      return;
    }
    job.endedAt = Date.now();
    job.exitCode = code ?? -1;
    job.signal = signal;
    job.state = code === 0 ? "succeeded" : "failed";
    log("info", `job ${id} done`, {
      state: job.state,
      exitCode: code,
      signal,
      durationMs: job.endedAt - job.startedAt,
    });
  });

  jobs.set(id, job);
  log("info", `job ${id} started`, {
    toolName: opts.toolName,
    cmd: `${opts.binary} ${maskArgs(opts.args).join(" ")}`,
  });
  return stripChild(job);
}

function stripChild(j: InternalJob): Job {
  const { child, ...rest } = j;
  return rest;
}

export function getJob(id: string): Job | undefined {
  const j = jobs.get(id);
  return j ? stripChild(j) : undefined;
}

export function listJobs(): Job[] {
  return Array.from(jobs.values())
    .map(stripChild)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function cancelJob(id: string): { ok: boolean; reason?: string } {
  const j = jobs.get(id);
  if (!j) return { ok: false, reason: "no such job" };
  if (j.state !== "running") return { ok: false, reason: `job is in state '${j.state}'` };
  j.state = "cancelled";
  j.endedAt = Date.now();
  if (j.child && !j.child.killed) {
    j.child.kill("SIGTERM");
    setTimeout(() => {
      if (j.child && !j.child.killed) j.child.kill("SIGKILL");
    }, 5000);
  }
  log("info", `job ${id} cancelled`);
  return { ok: true };
}

export async function waitForJob(id: string, timeoutMs: number): Promise<Job | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const j = jobs.get(id);
    if (!j) return undefined;
    if (j.state !== "running") return stripChild(j);
    await new Promise(r => setTimeout(r, 500));
  }
  const j = jobs.get(id);
  return j ? stripChild(j) : undefined;
}

export function killAllRunning(): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.state === "running" && j.child && !j.child.killed) {
      j.child.kill("SIGTERM");
      n++;
    }
  }
  if (n > 0) log("info", `killed ${n} running jobs on shutdown`);
  return n;
}

export function summarizeJob(job: Job): string {
  const dur = (job.endedAt ?? Date.now()) - job.startedAt;
  const cmd = `${job.binary} ${maskArgs(job.args).join(" ")}`;
  const lines = [
    `id=${job.id}`,
    `tool=${job.toolName}`,
    `state=${job.state}`,
    `duration=${dur}ms`,
  ];
  if (job.exitCode !== undefined) lines.push(`exitCode=${job.exitCode}`);
  if (job.signal) lines.push(`signal=${job.signal}`);
  return `${lines.join(" ")}\ncmd: ${cmd}`;
}

// Helper for tools with `background: true` mode — spawns a tracked job and returns a tool-result
// describing the job id and how to track it.
export function backgroundResult(
  toolName: string,
  binary: PacBinary,
  args: string[],
  cwd?: string,
): { isError?: boolean; content: { type: "text"; text: string; [x: string]: unknown }[]; [x: string]: unknown } {
  const job = startJob({ toolName, binary, args, cwd });
  const text =
    `Started background job.\n${summarizeJob(job)}\n\n` +
    `Track with:\n` +
    `  • job_status id=${job.id}  (current output)\n` +
    `  • job_wait id=${job.id}    (block until done)\n` +
    `  • job_cancel id=${job.id}  (kill local process)\n` +
    `  • admin_status              (server-side ops in tenant)`;
  return { content: [{ type: "text", text }] };
}
