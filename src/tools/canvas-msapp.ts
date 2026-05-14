// Canvas .msapp manipulation tools (Phase D). These complement the existing
// canvas_pack / canvas_unpack / canvas_download tools by doing what Microsoft's
// `pac canvas pack` officially can't: keep YAML and JSON sides of the .msapp
// internals synchronized so edits to .pa.yaml files actually reach Studio.
//
// All four tools are LOCAL-ONLY: no network, no tenant calls, no pac shell-out.
// That keeps them fast and reliable across macOS / Linux / Windows.
//
// They share the same MCP result shape as the rest of power-platform-mcp so
// Claude's output rendering stays consistent.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  openMsapp,
  writeMsapp,
  parsePaYamlMany,
  syncYamlTreeToJson,
  findControlByName,
  findControlFileByTopName,
  findRule,
  setControlProperty,
  patchYamlProperty,
  validatePaYaml,
  collectControls,
  normalizeZipPath,
  type MsappTree,
  type SyncReport,
  type YamlValidationIssue,
} from "../canvas-msapp.js";
import { log } from "../logger.js";
import type { ToolResult } from "../runner.js";

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

function ok(text: string, hint?: string): ToolResult {
  const body = hint ? `${text}\n\n--- hint ---\n${hint}` : text;
  return { content: [{ type: "text", text: body }] };
}

function fail(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function assertFile(path: string, label: string): string | null {
  if (!existsSync(path)) return `${label}: file not found at ${path}`;
  try {
    const s = statSync(path);
    if (!s.isFile()) return `${label}: path exists but is not a file (${path})`;
  } catch (err) {
    return `${label}: stat failed — ${(err as Error).message}`;
  }
  return null;
}

/**
 * Aggregate sync-report lines into a compact human-readable summary. The full
 * structured report is also returned in the second slot for callers/agents that
 * want machine-parsable output.
 */
function formatSyncReports(reports: SyncReport[]): { summary: string; structured: string } {
  const updated = reports.reduce((s, r) => s + r.propertiesUpdated, 0);
  const added = reports.reduce((s, r) => s + r.propertiesAdded, 0);
  const skipped = reports.reduce((s, r) => s + r.propertiesSkipped, 0);
  const touched = reports.reduce((s, r) => s + r.controlsTouched, 0);
  const allWarnings = reports.flatMap(r => r.warnings.map(w => `  ${r.yamlFile}: ${w}`));
  const lines: string[] = [];
  lines.push(`Synced ${reports.length} YAML file(s) → ${new Set(reports.map(r => r.jsonFile)).size} JSON file(s).`);
  lines.push(`  controls touched:     ${touched}`);
  lines.push(`  properties updated:   ${updated}`);
  lines.push(`  properties added:     ${added}`);
  if (skipped) {
    lines.push(`  properties skipped:   ${skipped}  (YAML has prop with no JSON Rule match; pass allow_add_new:true to add)`);
  }
  if (allWarnings.length) {
    lines.push(`  warnings (${allWarnings.length}):`);
    for (const w of allWarnings.slice(0, 20)) lines.push(w);
    if (allWarnings.length > 20) lines.push(`  ... ${allWarnings.length - 20} more`);
  }
  return { summary: lines.join("\n"), structured: JSON.stringify(reports, null, 2) };
}

// -----------------------------------------------------------------------------
// canvas_pack_sync — the headline tool
// -----------------------------------------------------------------------------

export function registerCanvasMsapp(server: McpServer) {
  server.tool(
    "canvas_pack_sync",
    "Pack an unpacked canvas source directory back into a .msapp, AND synchronize " +
    "every `Src/*.pa.yaml` formula into the corresponding `Controls/*.json` (or " +
    "`Components/*.json`) `InvariantScript` field. This is the fix for the well-known " +
    "issue (PowerApps-Tooling KnownIssues.md PA3013) where `pac canvas pack` updates " +
    "YAML without writing back to JSON, leaving Studio with stale formulas. " +
    "Local-only operation — does not contact any tenant. " +
    "INPUT: a directory produced by `canvas_unpack` (containing Controls/, Src/, etc.). " +
    "OUTPUT: a .msapp file at `output` whose JSON Rules match the YAML formulas.",
    {
      sources: z.string().describe("Unpacked sources directory (must contain Controls/ and Src/)"),
      output: z.string().describe("Output .msapp file path"),
      confirm: z.boolean().describe("Set true to perform the pack-and-sync; safety gate so accidental calls don't overwrite a real .msapp."),
      overwrite: z.boolean().default(false).describe("Allow overwriting an existing file at `output`"),
      allow_add_new: z.boolean().default(false).describe(
        "When true, YAML properties that have no matching JSON Rule get added as new rules. " +
        "Default false because YAML often carries properties that live in JSON's ControlPropertyState " +
        "(LayoutMaxHeight, FillPortions, etc.) — adding them would duplicate state. Enable only if " +
        "you ADDED new properties to the YAML and need them written through.",
      ),
    },
    async ({ sources, output, confirm, overwrite, allow_add_new }): Promise<ToolResult> => {
      if (!confirm) {
        return fail(
          "BLOCKED: canvas_pack_sync rewrites the .msapp at `output`. Re-call with confirm:true. " +
          "Tip: run canvas_validate_yaml first on the same sources directory to catch syntax errors " +
          "before they get baked into the .msapp.",
        );
      }
      if (existsSync(output)) {
        // Phase E review fix (important #7): existsSync alone doesn't distinguish file-vs-dir.
        // If `output` happens to be a directory, writeFile fails with a cryptic EISDIR
        // mid-pack. Catch it early with an actionable message.
        try {
          if (statSync(output).isDirectory()) {
            return fail(
              `Output path ${output} is an existing DIRECTORY, not a file. ` +
              `Pass a filename like ${output.replace(/\/$/, "")}/packed.msapp.`,
            );
          }
        } catch { /* ignore stat errors; existsSync said yes, writeFile will report concretely */ }
        if (!overwrite) {
          return fail(`Refusing to overwrite existing file at ${output}. Pass overwrite:true to proceed.`);
        }
      }
      try {
        const tree = await packDirToMsapp(sources);

        // For each Src/*.pa.yaml, parse and sync into JSON. A single YAML file can
        // contain multiple controls (e.g. ComponentDefinitions: groups several), so
        // we use parsePaYamlMany and emit one report per parsed sub-tree.
        const reports: SyncReport[] = [];
        for (const [path, yamlText] of tree.yamlFiles.entries()) {
          // Editor state files (`_EditorState.pa.yaml`) are Studio-managed metadata,
          // not formula sources. Skip — syncing would emit noisy warnings.
          if (normalizeZipPath(path).endsWith("_EditorState.pa.yaml")) continue;
          const yamlTrees = parsePaYamlMany(yamlText);
          if (yamlTrees.length === 0) {
            reports.push({
              yamlFile: path, jsonFile: "(parse failed)",
              controlsTouched: 0, propertiesUpdated: 0, propertiesAdded: 0, propertiesSkipped: 0,
              warnings: ["YAML parse failed — file skipped. Run canvas_validate_yaml for details."],
            });
            continue;
          }
          for (const yamlTree of yamlTrees) {
            const report = syncYamlTreeToJson(tree, yamlTree, path, { allowAddNew: allow_add_new });
            reports.push(report);
          }
        }
        await writeMsapp(tree, output);

        const { summary, structured } = formatSyncReports(reports);
        log("info", "canvas_pack_sync", { output, ...summarizeNumbers(reports) });
        return ok(
          `Packed ${sources} → ${output}.\n\n${summary}\n\n--- structured report (JSON) ---\n${structured}`,
          "Next step: upload the .msapp to your tenant via Power Apps Studio Import or by repacking " +
          "the solution that contains it (`pacx_solution`).",
        );
      } catch (err) {
        return fail(`canvas_pack_sync failed: ${(err as Error).message}`);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // canvas_patch_property — surgical edit
  // ---------------------------------------------------------------------------
  server.tool(
    "canvas_patch_property",
    "Update ONE property's formula on ONE control inside a packed .msapp, without " +
    "doing a full unpack/pack cycle. Writes to both the JSON `InvariantScript` (which " +
    "Studio reads) AND the matching `Src/*.pa.yaml` block (which source control sees). " +
    "Use for small targeted edits — adding a line to App.OnStart, flipping a Visible " +
    "formula, etc. For bulk changes, edit the unpacked source and run canvas_pack_sync.",
    {
      msapp: z.string().describe("Existing .msapp file to patch (modified in place unless `output` is set)"),
      output: z.string().optional().describe("Write the patched .msapp here instead of overwriting the input"),
      control: z.string().describe("Control Name, e.g. 'App' or 'Button1' or a screen name. Must match the JSON `Name` field exactly."),
      property: z.string().describe("Property name, e.g. 'OnStart', 'OnVisible', 'Text', 'Visible'."),
      new_value: z.string().describe(
        "New formula. Include the leading '=' as you would write it in YAML. The leading '=' is stripped automatically when writing to JSON (which doesn't carry it).",
      ),
      confirm: z.boolean().describe("Set true to actually write."),
    },
    async ({ msapp, output, control, property, new_value, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return fail("BLOCKED: canvas_patch_property mutates the .msapp. Re-call with confirm:true.");
      }
      const err1 = assertFile(msapp, "msapp");
      if (err1) return fail(err1);
      const dest = output ?? msapp;
      try {
        const tree = await openMsapp(msapp);
        const node = findControlByName(tree, control);
        if (!node) {
          // Surface what control names ARE available so the caller can correct the typo.
          const known = listAllControlNames(tree).slice(0, 30);
          return fail(
            `Control '${control}' not found in ${msapp}. ` +
            `Available control names (first 30): ${known.join(", ")}${known.length === 30 ? ", …" : ""}`,
          );
        }
        const outcome = setControlProperty(node, property, new_value);

        // Mark the owning ControlFile dirty.
        for (const cf of tree.controlJsons.values()) {
          const here = collectControls(cf.json.TopParent);
          if (here.some(n => n === node)) {
            cf.dirty = true;
            break;
          }
        }

        // Try to sync the YAML side. For top-level controls (App, screens, component
        // definitions), the YAML file lives at Src/<Name>.pa.yaml or Src/Components/<Name>.pa.yaml.
        let yamlPatched: "yes" | "no" | "not-attempted" = "not-attempted";
        const topOwner = findTopOwner(tree, node);
        if (topOwner) {
          const yamlKey = guessYamlPathFor(tree, topOwner.Name);
          if (yamlKey) {
            const oldYaml = tree.yamlFiles.get(yamlKey) ?? "";
            // We only attempt single-property YAML patching for properties on the top
            // owner — patching a nested control's property in YAML is more fragile and
            // is the canvas_pack_sync job. Surface a hint when we skip.
            if (topOwner === node) {
              const newYaml = patchYamlProperty(oldYaml, control, property, new_value);
              if (newYaml && newYaml !== oldYaml) {
                tree.yamlFiles.set(yamlKey, newYaml);
                yamlPatched = "yes";
              } else {
                yamlPatched = "no";
              }
            }
          }
        }

        await writeMsapp(tree, dest);

        const lines = [
          `${outcome === "updated" ? "Updated" : outcome === "added" ? "Added" : "Unchanged"}: ${control}.${property}`,
          `JSON ${outcome === "unchanged" ? "(unchanged)" : "written"}.`,
          `YAML side: ${yamlPatched === "yes" ? "patched in place"
            : yamlPatched === "no" ? "could not locate property block — JSON is the source of truth"
            : "not attempted (nested control; YAML stays in sync only via canvas_pack_sync)"}`,
          `Output: ${dest}`,
        ];
        return ok(lines.join("\n"));
      } catch (err) {
        return fail(`canvas_patch_property failed: ${(err as Error).message}`);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // canvas_diff — compare two .msapp / source directories
  // ---------------------------------------------------------------------------
  server.tool(
    "canvas_diff",
    "Diff two canvas apps and report which controls and properties differ. Both " +
    "operands can be either a packed `.msapp` file or an unpacked sources directory. " +
    "Surfaces a structured summary: controls added/removed, properties changed per " +
    "control (with old → new for InvariantScript). Useful as a pre-flight before " +
    "canvas_pack_sync or before importing a .msapp into a different environment.",
    {
      left: z.string().describe(".msapp file OR unpacked sources directory (the 'before' side)"),
      right: z.string().describe(".msapp file OR unpacked sources directory (the 'after' side)"),
      max_value_chars: z.number().int().positive().max(2000).default(200).describe(
        "Truncate each old/new formula value to this many characters in the diff output (so the textual diff doesn't blow up Claude's context).",
      ),
    },
    async ({ left, right, max_value_chars }): Promise<ToolResult> => {
      try {
        const a = await loadEitherMsappOrDir(left);
        const b = await loadEitherMsappOrDir(right);
        const diff = diffMsappTrees(a, b, max_value_chars);
        return ok(diff);
      } catch (err) {
        return fail(`canvas_diff failed: ${(err as Error).message}`);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // canvas_validate_yaml — pre-flight syntax check
  // ---------------------------------------------------------------------------
  server.tool(
    "canvas_validate_yaml",
    "Validate every `.pa.yaml` file under a canvas sources directory against the " +
    "Power Fx YAML grammar (leading-`=` rule, single-line vs block-scalar character " +
    "rules, top-level shape). Pre-flight check before canvas_pack_sync — catches " +
    "common author mistakes that would silently produce a broken .msapp.",
    {
      sources: z.string().describe("Unpacked sources directory (or a single .pa.yaml file)"),
    },
    async ({ sources }): Promise<ToolResult> => {
      try {
        const issues = await validateYamlPath(sources);
        if (!issues.length) {
          return ok(`✓ ${sources}: no YAML issues found across all .pa.yaml files.`);
        }
        const errs = issues.filter(i => i.severity === "error");
        const warns = issues.filter(i => i.severity === "warning");
        const lines: string[] = [];
        lines.push(`Found ${errs.length} error(s) and ${warns.length} warning(s):`);
        for (const i of issues.slice(0, 50)) {
          lines.push(`  [${i.severity.toUpperCase()}] ${i.file}:${i.line} — ${i.message}`);
        }
        if (issues.length > 50) lines.push(`  ... ${issues.length - 50} more`);
        if (errs.length) {
          return fail(lines.join("\n"));
        }
        return ok(lines.join("\n"));
      } catch (err) {
        return fail(`canvas_validate_yaml failed: ${(err as Error).message}`);
      }
    },
  );
}

// -----------------------------------------------------------------------------
// canvas_pack_sync support: load an unpacked directory back into an MsappTree
// -----------------------------------------------------------------------------

/**
 * Roll an unpacked sources directory into an MsappTree by zipping it up and
 * letting `openMsapp` parse the result. This is more code than calling `pac
 * canvas pack` and then opening the output, but it avoids the very bug we're
 * here to fix — pac's pack doesn't write JSON updates. We need the IN-MEMORY
 * tree before any sync runs, so we build it ourselves.
 *
 * The implementation walks the directory, adds each file to a fresh JSZip with
 * forward-slash separators (the convention the .msapp consumer expects on
 * cross-platform machines), then hands the buffer to `openMsapp` which already
 * knows how to parse it.
 */
async function packDirToMsapp(dir: string): Promise<MsappTree> {
  const JSZip = (await import("jszip")).default;
  const { readdir, writeFile, unlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");

  const zip = new JSZip();
  await walkAndAdd(dir, dir, zip, readdir);
  // Write to a temp buffer then re-open through the canonical pipeline so
  // anything downstream sees the same tree shape it'd see for a downloaded .msapp.
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const tempPath = nodePath.join(tmpdir(), `canvas-pack-${Date.now()}.msapp`);
  await writeFile(tempPath, buf);
  try {
    return await openMsapp(tempPath);
  } finally {
    // Phase E review fix (important #5): tempfile was leaking on every pack_sync call.
    // On a long-running Claude Desktop session this would accumulate /tmp clutter. Now
    // we delete after openMsapp has loaded everything into memory.
    try { await unlink(tempPath); } catch { /* best-effort */ }
  }
}

async function walkAndAdd(
  baseDir: string,
  current: string,
  zip: import("jszip"),
  readdir: typeof import("node:fs/promises").readdir,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const e of entries) {
    const full = join(current, e.name);
    if (e.isDirectory()) {
      await walkAndAdd(baseDir, full, zip, readdir);
    } else if (e.isFile()) {
      // Skip platform droppings.
      if (e.name === ".DS_Store" || e.name === "Thumbs.db") continue;
      const relPath = relative(baseDir, full).split(/[\\/]/).join("/");
      const data = readFileSync(full);
      zip.file(relPath, data);
    }
  }
}

// -----------------------------------------------------------------------------
// canvas_diff support
// -----------------------------------------------------------------------------

async function loadEitherMsappOrDir(path: string): Promise<MsappTree> {
  if (!existsSync(path)) throw new Error(`Path not found: ${path}`);
  const s = statSync(path);
  if (s.isDirectory()) return packDirToMsapp(path);
  return openMsapp(path);
}

interface FlatProperty {
  control: string;
  property: string;
  invariantScript: string;
}

function flattenProperties(tree: MsappTree): Map<string, FlatProperty> {
  const out = new Map<string, FlatProperty>();
  for (const cf of tree.controlJsons.values()) {
    for (const node of collectControls(cf.json.TopParent)) {
      for (const rule of node.Rules ?? []) {
        const key = `${node.Name}.${rule.Property}`;
        out.set(key, {
          control: node.Name,
          property: rule.Property,
          invariantScript: rule.InvariantScript ?? "",
        });
      }
    }
  }
  return out;
}

function diffMsappTrees(a: MsappTree, b: MsappTree, maxChars: number): string {
  const left = flattenProperties(a);
  const right = flattenProperties(b);
  const allKeys = new Set<string>([...left.keys(), ...right.keys()]);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: { key: string; before: string; after: string }[] = [];

  for (const k of allKeys) {
    const l = left.get(k);
    const r = right.get(k);
    if (l && !r) removed.push(k);
    else if (!l && r) added.push(k);
    else if (l && r && l.invariantScript !== r.invariantScript) {
      changed.push({ key: k, before: l.invariantScript, after: r.invariantScript });
    }
  }

  const truncate = (s: string) => s.length > maxChars ? s.slice(0, maxChars) + `… (+${s.length - maxChars} chars)` : s;
  const lines: string[] = [];
  lines.push(`Diff: ${a.controlJsons.size} control file(s) vs ${b.controlJsons.size}`);
  lines.push(`  added properties:   ${added.length}`);
  lines.push(`  removed properties: ${removed.length}`);
  lines.push(`  changed properties: ${changed.length}`);
  if (added.length) {
    lines.push("\nAdded:");
    for (const k of added.slice(0, 30)) lines.push(`  + ${k}`);
    if (added.length > 30) lines.push(`  ... ${added.length - 30} more`);
  }
  if (removed.length) {
    lines.push("\nRemoved:");
    for (const k of removed.slice(0, 30)) lines.push(`  - ${k}`);
    if (removed.length > 30) lines.push(`  ... ${removed.length - 30} more`);
  }
  if (changed.length) {
    lines.push("\nChanged:");
    for (const c of changed.slice(0, 20)) {
      lines.push(`  ~ ${c.key}`);
      lines.push(`      before: ${truncate(c.before)}`);
      lines.push(`      after:  ${truncate(c.after)}`);
    }
    if (changed.length > 20) lines.push(`  ... ${changed.length - 20} more`);
  }
  if (!added.length && !removed.length && !changed.length) {
    lines.push("\n✓ No property-level differences.");
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// canvas_validate_yaml support
// -----------------------------------------------------------------------------

async function validateYamlPath(sourcePath: string): Promise<YamlValidationIssue[]> {
  const { readdir } = await import("node:fs/promises");
  if (!existsSync(sourcePath)) throw new Error(`Path not found: ${sourcePath}`);
  const s = statSync(sourcePath);
  const out: YamlValidationIssue[] = [];
  if (s.isFile()) {
    if (!sourcePath.endsWith(".pa.yaml")) {
      throw new Error(`Not a .pa.yaml file: ${sourcePath}`);
    }
    const text = readFileSync(sourcePath, "utf8");
    out.push(...validatePaYaml(text, sourcePath));
    return out;
  }
  // Directory: walk for *.pa.yaml.
  const stack: string[] = [sourcePath];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".pa.yaml")) {
        if (e.name === "_EditorState.pa.yaml") continue; // metadata, not source
        const text = readFileSync(full, "utf8");
        out.push(...validatePaYaml(text, full));
      }
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Misc helpers
// -----------------------------------------------------------------------------

function listAllControlNames(tree: MsappTree): string[] {
  const names = new Set<string>();
  for (const cf of tree.controlJsons.values()) {
    for (const n of collectControls(cf.json.TopParent)) names.add(n.Name);
  }
  return [...names].sort();
}

/** Return the top-level control node (App / Screen / Component) that contains `node`. */
function findTopOwner(tree: MsappTree, node: import("../canvas-msapp.js").ControlNode): import("../canvas-msapp.js").ControlNode | null {
  for (const cf of tree.controlJsons.values()) {
    const list = collectControls(cf.json.TopParent);
    if (list.includes(node)) return cf.json.TopParent;
  }
  return null;
}

/**
 * Best-effort match: for top-name "App" return `Src/App.pa.yaml`, for a screen
 * "Dashboard" return `Src/Dashboard.pa.yaml`, etc. Tolerates both forward-slash
 * and backslash zip-path conventions.
 */
function guessYamlPathFor(tree: MsappTree, topName: string): string | null {
  const candidates = [`Src/${topName}.pa.yaml`, `Src/Components/${topName}.pa.yaml`];
  for (const key of tree.yamlFiles.keys()) {
    const n = normalizeZipPath(key);
    if (candidates.includes(n)) return key;
  }
  return null;
}

function summarizeNumbers(reports: SyncReport[]): { yamlFiles: number; touched: number; updated: number; added: number; warnings: number } {
  return {
    yamlFiles: reports.length,
    touched: reports.reduce((s, r) => s + r.controlsTouched, 0),
    updated: reports.reduce((s, r) => s + r.propertiesUpdated, 0),
    added: reports.reduce((s, r) => s + r.propertiesAdded, 0),
    warnings: reports.reduce((s, r) => s + r.warnings.length, 0),
  };
}
