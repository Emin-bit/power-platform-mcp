const DESTRUCTIVE_SUBVERBS = new Set([
  "delete",
  "delete-environment",
  "delete-tenant-settings",
  "reset",
  "restore",
  "wipe",
  "remove",
  "destroy",
  "uninstall",
]);

const DESTRUCTIVE_FULL_PATTERNS: string[][] = [
  ["admin", "copy"],
  ["env", "copy"],
  ["solution", "import"],
  ["solution", "upgrade"],
  ["solution", "apply-upgrade"],
  ["solution", "clone-and-merge"],
  ["package", "deploy"],
  ["pipeline", "deploy"],
  ["data", "import"],
];

const FORCE_FLAGS = new Set([
  "--force",
  "--overwrite",
  "--force-overwrite",
  "--force-import",
  "--forceUploadAll",
  "--force-upload-all",
]);

export interface SafetyVerdict {
  destructive: boolean;
  reason?: string;
}

export function isDestructive(args: string[]): SafetyVerdict {
  if (args.length >= 2 && DESTRUCTIVE_SUBVERBS.has(args[1])) {
    return { destructive: true, reason: `'${args[0]} ${args[1]}' is a destructive operation` };
  }
  for (const pat of DESTRUCTIVE_FULL_PATTERNS) {
    if (pat.every((tok, i) => args[i] === tok)) {
      return { destructive: true, reason: `'${pat.join(" ")}' can overwrite or affect production data` };
    }
  }
  for (const a of args) {
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (FORCE_FLAGS.has(flag)) {
      return { destructive: true, reason: `command uses force/overwrite flag '${flag}'` };
    }
  }
  return { destructive: false };
}

export function safeModeEnabled(): boolean {
  const v = (process.env.PAC_MCP_SAFE_MODE ?? "on").toLowerCase();
  return v !== "off" && v !== "0" && v !== "false" && v !== "no";
}
