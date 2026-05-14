// Canvas .msapp internals — read, mutate, write.
//
// Why this module exists: `pac canvas pack` (Preview + Deprecated) is officially known
// not to sync changes from `Src/*.pa.yaml` back into `Controls/<N>.json`. The Studio
// runtime loads from JSON. So edits to YAML never reach the live app unless something
// else syncs them. This is confirmed by Microsoft's own KnownIssues.md:
//   - PA3013: InvariantScript value of controls with component definition set to false
//     is not in sync with the same field in the component definition.
//   - PA3013: AllowAccessToGlobals desync between Components/<N>.json and
//     ComponentsMetadata.json.
//
// This module gives us a faithful zip + YAML + JSON pipeline so the canvas_* MCP tools
// can do what `pac canvas pack` won't: read both representations, modify either side,
// keep them in sync, repack.
//
// References:
//   - YAML grammar:    https://learn.microsoft.com/power-platform/power-fx/yaml-formula-grammar
//   - pa.yaml v3 schema: github.com/microsoft/PowerApps-Tooling/blob/master/schemas/pa-yaml/v3.0/pa.schema.yaml
//   - KnownIssues.md:   github.com/microsoft/PowerApps-Tooling/blob/master/docs/KnownIssues.md
//
// Format quick-reference (real-world Lamello sample, verified against this code):
//   <msapp>.zip/
//     Controls/<N>.json   — one JSON per screen/app, contains TopParent { Name, Rules, Children, ... }
//     Components/<N>.json — same shape, for custom components
//     Src/App.pa.yaml     — App-level YAML; maps to the Controls/*.json whose TopParent.Name == "App"
//     Src/<Screen>.pa.yaml — per-screen YAML; maps by name
//     Src/Components/*.pa.yaml — per-component YAML
//     CanvasManifest.json, Header.json, Properties.json, References/*.json — metadata
//
// JSON property shape (a "Rule"):
//   { Property: "OnStart", Category: "Behavior", InvariantScript: "Set(x,1);", RuleProviderType: "Unknown" }
//
// YAML property shape:
//   Properties:
//     OnStart: |-
//       =Set(x,1);
//   The leading `=` is REQUIRED by Power Fx YAML grammar; JSON's InvariantScript has it STRIPPED.

import { readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { load as yamlLoad } from "js-yaml";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface MsappTree {
  /** The opened JSZip instance — keep alive so we can pack back. */
  zip: JSZip;
  /** Path → parsed JSON for every Controls/*.json + Components/*.json we touched. */
  controlJsons: Map<string, ControlFile>;
  /** Path → raw YAML text for every Src/*.pa.yaml we touched. */
  yamlFiles: Map<string, string>;
  /** Top-level msapp metadata (Header.json contents). Read-only convenience. */
  header: Record<string, unknown> | null;
}

/** One Controls/<N>.json or Components/<N>.json file, parsed. */
export interface ControlFile {
  /** Path inside the zip — e.g. "Controls/1.json" or with Windows-style backslashes. */
  path: string;
  /** The parsed JSON content. The shape is `{ TopParent: ControlNode }`. */
  json: { TopParent: ControlNode } & Record<string, unknown>;
  /** Whether we've mutated `json` and need to rewrite it on pack. */
  dirty: boolean;
}

/** A control node in JSON form (App, Screen, Label, Button, Gallery, etc.). */
export interface ControlNode {
  Type?: number | string;
  Name: string;
  Template?: unknown;
  Rules?: Rule[];
  Children?: ControlNode[];
  ControlPropertyState?: unknown[];
  /** Component definitions carry these; ordinary controls don't. */
  AllowAccessToGlobals?: boolean;
  // Many other fields exist (StyleName, LayoutName, etc.) — passthrough untouched.
  [key: string]: unknown;
}

/** One Property → InvariantScript binding inside a control's Rules array. */
export interface Rule {
  Property: string;
  Category?: string;
  InvariantScript: string;
  /** Some msapp versions emit a localized `Script` mirror — keep it in sync if present. */
  Script?: string;
  RuleProviderType?: string;
  [key: string]: unknown;
}

/** Mirrors the pa.yaml v3.0 schema — only the fields we need. */
export interface PaYamlTree {
  /** Single top-level entry (App, a screen, or a component definition). */
  topName: string;
  /** Power Fx property formulas at this level. Values include the leading `=`. */
  properties: Record<string, string>;
  /** Nested children, recursively. */
  children: PaYamlChild[];
}

export interface PaYamlChild {
  name: string;
  /** ControlTypeId — e.g. "Label", "Button", "Gallery.horizontalGallery". */
  controlType?: string;
  properties: Record<string, string>;
  children: PaYamlChild[];
}

/** Audit trail of what changed in a sync pass. Surfaced in MCP tool output. */
export interface SyncReport {
  yamlFile: string;
  jsonFile: string;
  controlsTouched: number;
  propertiesUpdated: number;
  propertiesAdded: number;
  /**
   * Count of YAML properties that have no matching JSON Rule and were skipped
   * because `allowAddNew=false`. These usually correspond to properties stored
   * on the JSON side as `ControlPropertyState.AutoRuleBindingString` rather than
   * `Rules` — adding them would create duplicates Studio doesn't expect.
   */
  propertiesSkipped: number;
  warnings: string[];
}

// -----------------------------------------------------------------------------
// Read / write zip
// -----------------------------------------------------------------------------

/**
 * Open a .msapp file (which is a zip) and return a tree that holds the JSZip plus
 * lazily-parsed copies of every Controls/*.json / Components/*.json / Src/*.pa.yaml
 * we expect to mutate.
 *
 * We deliberately keep the JSZip in `tree.zip` so callers can edit additional entries
 * (e.g. CanvasManifest.json) without us round-tripping every file in the archive.
 */
export async function openMsapp(msappPath: string): Promise<MsappTree> {
  const data = await readFile(msappPath);
  const zip = await JSZip.loadAsync(data);
  const tree: MsappTree = {
    zip,
    controlJsons: new Map(),
    yamlFiles: new Map(),
    header: null,
  };

  // Pre-read every Controls/* and Components/* JSON. They're small (~few KB) and
  // we always want them for sync. Use the normalized forward-slash key so callers
  // don't have to think about Windows-style backslash entries.
  const entries = listZipEntries(zip);
  for (const path of entries) {
    if (isControlOrComponentJsonPath(path)) {
      const raw = await zip.file(path)!.async("string");
      try {
        const json = JSON.parse(raw);
        if (json && typeof json === "object" && json.TopParent) {
          tree.controlJsons.set(path, { path, json, dirty: false });
        }
      } catch {
        // Skip non-control JSONs that happen to live in Controls/ — unlikely but defensive.
      }
    } else if (isPaYamlPath(path)) {
      const raw = await zip.file(path)!.async("string");
      tree.yamlFiles.set(path, raw);
    } else if (normalizeZipPath(path) === "Header.json") {
      try {
        tree.header = JSON.parse(await zip.file(path)!.async("string"));
      } catch {
        tree.header = null;
      }
    }
  }
  return tree;
}

/**
 * Write the (possibly mutated) tree back to a new .msapp at `outputPath`. Only
 * entries marked `dirty` are re-serialized; everything else is passed through
 * untouched, preserving original byte content + entry order where possible.
 *
 * NOTE: JSZip rebuilds the central directory; binary identity with the original
 * is NOT guaranteed even when no files changed. That's accepted — Studio doesn't
 * care about byte identity, only about the zip's logical contents + the
 * `checksum.json` if present (which `pac canvas pack` will regenerate when called
 * separately).
 */
export async function writeMsapp(tree: MsappTree, outputPath: string): Promise<void> {
  // Re-serialize dirty control JSONs back into the zip.
  for (const cf of tree.controlJsons.values()) {
    if (!cf.dirty) continue;
    const serialized = JSON.stringify(cf.json, null, 2);
    tree.zip.file(cf.path, serialized);
  }
  // YAML files: if a caller patched them via `tree.yamlFiles.set(path, newText)`,
  // re-write into the zip. We don't track dirty here — last-write-wins.
  for (const [path, text] of tree.yamlFiles.entries()) {
    tree.zip.file(path, text);
  }
  const buf = await tree.zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    // Match Microsoft's pack output convention: ZIP entries with forward-slash
    // separators (JSZip's default).
  });
  await writeFile(outputPath, buf);
}

function listZipEntries(zip: JSZip): string[] {
  const out: string[] = [];
  zip.forEach((relativePath, file) => {
    if (!file.dir) out.push(relativePath);
  });
  return out;
}

/**
 * Microsoft Studio writes some `.msapp` archives with backslash separators inside
 * the zip entry names (legacy Windows-only behavior). Normalize for the path
 * predicates so a downstream consumer doesn't have to write `Controls\\1.json`
 * everywhere. The original entry key is preserved on `ControlFile.path` so we
 * can write back to the same key on pack.
 */
export function normalizeZipPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function isControlOrComponentJsonPath(p: string): boolean {
  const n = normalizeZipPath(p);
  return /^Controls\/[^\/]+\.json$/.test(n) || /^Components\/[^\/]+\.json$/.test(n);
}

function isPaYamlPath(p: string): boolean {
  const n = normalizeZipPath(p);
  return /^Src\/.*\.pa\.yaml$/.test(n);
}

// -----------------------------------------------------------------------------
// Control tree navigation (JSON side)
// -----------------------------------------------------------------------------

/**
 * Find a control node by its `Name` anywhere in the loaded JSON. Searches the
 * `TopParent` of every Controls/*.json and Components/*.json, descending into
 * `Children[]`. Returns the FIRST match — caller is responsible for ambiguous
 * names (which shouldn't happen in a well-formed app but can in WIP edits).
 */
export function findControlByName(tree: MsappTree, name: string): ControlNode | null {
  for (const cf of tree.controlJsons.values()) {
    const hit = walkControlTree(cf.json.TopParent, n => n.Name === name);
    if (hit) return hit;
  }
  return null;
}

/**
 * Find the ControlFile that contains a given top-level control name (App,
 * <ScreenName>, or a component name). Important: a Screen's children are stored
 * inside the SAME Controls/<N>.json as the screen — so to mutate a button inside
 * a screen, you load the screen's json, navigate down to the button, mutate, and
 * mark the FILE dirty.
 */
export function findControlFileByTopName(tree: MsappTree, name: string): ControlFile | null {
  for (const cf of tree.controlJsons.values()) {
    if (cf.json.TopParent?.Name === name) return cf;
  }
  return null;
}

/** Pre-order DFS through a control + its Children, returning the first match. */
export function walkControlTree(
  root: ControlNode,
  predicate: (node: ControlNode) => boolean,
): ControlNode | null {
  if (predicate(root)) return root;
  for (const child of root.Children ?? []) {
    const hit = walkControlTree(child, predicate);
    if (hit) return hit;
  }
  return null;
}

/** Same as walkControlTree but returns every match (used by diff + audit). */
export function collectControls(root: ControlNode): ControlNode[] {
  const out: ControlNode[] = [];
  const stack: ControlNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    for (const ch of n.Children ?? []) stack.push(ch);
  }
  return out;
}

/**
 * Locate a Rule by property name within a control. Each control has its property
 * formulas as a Rules array; the indexed access by name is the operation we do
 * over and over during YAML→JSON sync, so it gets a helper.
 */
export function findRule(control: ControlNode, property: string): Rule | null {
  return (control.Rules ?? []).find(r => r.Property === property) ?? null;
}

/**
 * Set the InvariantScript for a given property on a control.
 *
 * Strips a leading `=` if present (YAML→JSON convention: YAML keeps it, JSON omits it).
 * Also mirrors the value into the localized `Script` field when that field is
 * present on the rule (some msapp generations emit it; some don't).
 *
 * By default ONLY existing rules are updated. Adding brand-new rules is gated
 * behind `allowAddNew` because YAML often carries properties that live in JSON
 * under `ControlPropertyState.AutoRuleBindingString` rather than `Rules` (e.g.
 * `LayoutMaxHeight`, `FillPortions`). Adding them to `Rules` causes duplication
 * that confuses Studio. Real-world experiment on a Lamello canvas app: with
 * `allowAddNew=true`, a round-trip would add 1093 spurious rules; with
 * `allowAddNew=false` the round-trip is clean.
 *
 * Returns:
 *   "updated"   — existing rule changed value
 *   "added"     — new rule inserted (only happens when allowAddNew=true)
 *   "skipped"   — property doesn't exist on this control's Rules and allowAddNew=false
 *   "unchanged" — value already matched
 */
export function setControlProperty(
  control: ControlNode,
  property: string,
  yamlValue: string,
  allowAddNew = false,
): "updated" | "added" | "unchanged" | "skipped" {
  const stripped = stripLeadingEquals(yamlValue);
  const existing = findRule(control, property);
  if (existing) {
    if (existing.InvariantScript === stripped) return "unchanged";
    existing.InvariantScript = stripped;
    if ("Script" in existing && existing.Script !== undefined) {
      existing.Script = stripped;
    }
    return "updated";
  }
  if (!allowAddNew) return "skipped";
  control.Rules = control.Rules ?? [];
  control.Rules.push({
    Property: property,
    Category: "Behavior", // Default category. Studio re-categorizes on next save.
    InvariantScript: stripped,
    RuleProviderType: "Unknown",
  });
  return "added";
}

/**
 * YAML Power Fx values are written with a leading `=` per the grammar; JSON's
 * InvariantScript field stores them without. Strip exactly one leading `=`
 * (after trimming surrounding whitespace) — anything more is treated as part of
 * the formula (e.g. `==` is a real expression).
 */
export function stripLeadingEquals(yamlValue: string): string {
  // Some multiline blocks come through with surrounding whitespace from the
  // YAML parser. Normalize line endings but DON'T trim the body — Power Fx
  // preserves significant whitespace inside string literals.
  const normalized = yamlValue.replace(/\r\n/g, "\n");
  // Block scalar with `|-` keeps trailing whitespace trimmed; just strip the
  // leading `=` if present.
  if (normalized.startsWith("=")) return normalized.slice(1);
  // Multiline blocks sometimes have a leading newline before `=` — handle it.
  const leadingTrim = normalized.replace(/^\s*\n/, "");
  if (leadingTrim.startsWith("=")) return leadingTrim.slice(1);
  return normalized;
}

// -----------------------------------------------------------------------------
// YAML parsing
// -----------------------------------------------------------------------------

/**
 * Parse a `.pa.yaml` source file into one OR MORE structured trees. The Power Apps
 * YAML grammar accepts both:
 *   • Per-control files: top-level is the control header (`App:`, `Dashboard:`,
 *     `MyComponent As CanvasComponent:`)
 *   • Container files: top-level is a section key (`Screens:`, `ComponentDefinitions:`,
 *     `App:` with a nested screens map) — each entry inside is a separate control.
 *
 * For containerized files, this function returns one PaYamlTree per child, so the
 * caller treats them uniformly.
 *
 * Returns an empty array when the YAML is empty/unparseable; the caller surfaces
 * the error with the file path for context.
 */
export function parsePaYamlMany(yamlText: string): PaYamlTree[] {
  let raw: unknown;
  try {
    raw = yamlLoad(yamlText);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object") return [];
  const topEntries = Object.entries(raw as Record<string, unknown>);

  const trees: PaYamlTree[] = [];
  for (const [topName, topBody] of topEntries) {
    if (!topBody || typeof topBody !== "object") continue;
    if (CONTAINER_KEYS.has(topName)) {
      // Each direct child of a container key is its own control/component.
      for (const [childHeader, childBody] of Object.entries(topBody as Record<string, unknown>)) {
        if (!childBody || typeof childBody !== "object") continue;
        trees.push({
          topName: extractControlName(childHeader),
          properties: extractProperties(childBody as Record<string, unknown>),
          children: extractChildren(childBody as Record<string, unknown>),
        });
      }
    } else {
      trees.push({
        topName: extractControlName(topName),
        properties: extractProperties(topBody as Record<string, unknown>),
        children: extractChildren(topBody as Record<string, unknown>),
      });
    }
  }
  return trees;
}

/** Container section keys from the pa.yaml v3.0 schema — these wrap groups of named controls. */
const CONTAINER_KEYS = new Set(["Screens", "ComponentDefinitions", "DataSources"]);

/**
 * Backward-compat wrapper: returns the first parsed tree only (legacy single-control
 * file shape). New callers should prefer parsePaYamlMany.
 */
export function parsePaYaml(yamlText: string): PaYamlTree | null {
  const all = parsePaYamlMany(yamlText);
  return all[0] ?? null;
}

/**
 * pa.yaml control header can be either a bare name (`App`) or include the type
 * with the `As` operator (`Gallery1 As Gallery.horizontalGallery`). We need the
 * bare name for matching JSON's `Name` field.
 */
function extractControlName(header: string): string {
  // Headers can be quoted: `'Long Name' As Control`. Strip quotes from name.
  const asMatch = header.match(/^\s*['"]?(.+?)['"]?\s+As\s+(.+?)\s*$/);
  if (asMatch) return asMatch[1].trim();
  return header.trim();
}

function extractControlType(header: string): string | undefined {
  const asMatch = header.match(/^\s*['"]?(.+?)['"]?\s+As\s+(.+?)\s*$/);
  if (asMatch) return asMatch[2].trim();
  return undefined;
}

function extractProperties(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const props = body.Properties;
  if (!props || typeof props !== "object") return out;
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (typeof v === "string") {
      out[k] = v;
    } else if (v === null) {
      // YAML `null` ⇒ unset property. We leave it out so JSON keeps its existing rule.
    } else {
      // Non-string property — could be a boolean or number from YAML implicit typing.
      // pa.yaml grammar says values MUST start with `=`, so anything non-string is malformed.
      // Convert to string with a leading `=` for forgiving behavior.
      out[k] = "=" + String(v);
    }
  }
  return out;
}

function extractChildren(body: Record<string, unknown>): PaYamlChild[] {
  const childrenRaw = body.Children;
  if (!Array.isArray(childrenRaw)) return [];
  const out: PaYamlChild[] = [];
  for (const entry of childrenRaw) {
    if (!entry || typeof entry !== "object") continue;
    // Each entry is a single-property map: { "Label1 As Label": {...properties...} }.
    const entries = Object.entries(entry as Record<string, unknown>);
    if (entries.length !== 1) continue;
    const [header, childBody] = entries[0];
    if (!childBody || typeof childBody !== "object") continue;
    out.push({
      name: extractControlName(header),
      controlType: extractControlType(header),
      properties: extractProperties(childBody as Record<string, unknown>),
      children: extractChildren(childBody as Record<string, unknown>),
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// YAML → JSON sync
// -----------------------------------------------------------------------------

/**
 * The headline operation. Given a parsed `.pa.yaml` tree, find the matching
 * Controls/*.json (by top-level Name) and update every InvariantScript in the
 * JSON to match the YAML's value. Children are matched recursively by Name.
 *
 * Returns a structured report so the caller can decide whether the result is
 * trustworthy enough to use (e.g. zero properties updated when the YAML clearly
 * has formulas is a red flag — probably a control-name mismatch).
 *
 * Side effect: marks the matched ControlFile as `dirty` so `writeMsapp` will
 * re-serialize it.
 */
export function syncYamlTreeToJson(
  tree: MsappTree,
  yamlTree: PaYamlTree,
  yamlFilePath: string,
  options: { allowAddNew?: boolean } = {},
): SyncReport {
  const report: SyncReport = {
    yamlFile: yamlFilePath,
    jsonFile: "(no match)",
    controlsTouched: 0,
    propertiesUpdated: 0,
    propertiesAdded: 0,
    propertiesSkipped: 0,
    warnings: [],
  };

  const cf = findControlFileByTopName(tree, yamlTree.topName);
  if (!cf) {
    report.warnings.push(
      `No Controls/*.json or Components/*.json has TopParent.Name === '${yamlTree.topName}'. ` +
      `Either the YAML is for a control that no longer exists in the msapp, or the YAML's ` +
      `top-level name differs from the JSON's Name field.`,
    );
    return report;
  }
  report.jsonFile = cf.path;

  syncOneControl(cf.json.TopParent, yamlTree, report, options.allowAddNew ?? false);
  if (report.propertiesUpdated > 0 || report.propertiesAdded > 0) {
    cf.dirty = true;
  }
  return report;
}

function syncOneControl(jsonControl: ControlNode, yamlControl: PaYamlTree | PaYamlChild, report: SyncReport, allowAddNew: boolean): void {
  report.controlsTouched++;
  for (const [property, yamlValue] of Object.entries(yamlControl.properties)) {
    const outcome = setControlProperty(jsonControl, property, yamlValue, allowAddNew);
    if (outcome === "updated") report.propertiesUpdated++;
    else if (outcome === "added") report.propertiesAdded++;
    else if (outcome === "skipped") report.propertiesSkipped++;
  }
  // Recurse: pair YAML children with JSON children by Name. We don't reorder JSON
  // children if YAML order differs — that would change z-index in Studio. We just
  // sync values.
  const jsonChildren = jsonControl.Children ?? [];
  const childByName = new Map<string, ControlNode>(jsonChildren.map(c => [c.Name, c]));
  for (const yamlChild of yamlControl.children) {
    const match = childByName.get(yamlChild.name);
    if (!match) {
      report.warnings.push(
        `YAML control '${yamlChild.name}' has no matching child in JSON (parent: '${(yamlControl as PaYamlTree).topName ?? (yamlControl as PaYamlChild).name}'). Skipped.`,
      );
      continue;
    }
    syncOneControl(match, yamlChild, report, allowAddNew);
  }
}

// -----------------------------------------------------------------------------
// JSON → YAML sync (round-trip helper)
// -----------------------------------------------------------------------------

/**
 * For canvas_patch_property: after we mutate the JSON, write the new formula
 * back into the YAML text so the source-controlled view stays in sync. This
 * does a text-level substitution rather than a full re-emit, to preserve any
 * comments and formatting the user added to the YAML.
 *
 * Returns the new YAML text. If the property block can't be located, returns
 * null and the caller falls back to emitting a warning (the JSON side is still
 * correct in that case, which is the side Studio reads from).
 */
export function patchYamlProperty(
  yamlText: string,
  controlName: string,
  property: string,
  newValueWithEquals: string,
): string | null {
  // Match `<indent>Property: =<value>` (single-line) or
  // `<indent>Property: |[-+]?\n<indent>+  =<value...>` (multi-line block scalar).
  // We accept either style and replace just the value, keeping the property's
  // existing block-scalar indicator if it had one.
  //
  // We DON'T try to scope by control name yet — for OnStart / OnVisible on the
  // App, there's only ever one match. For the surgical-edit tool, the caller
  // already loaded the right YAML file. A more careful impl with control-name
  // scoping is a Phase D follow-up if multi-control collisions become an issue.
  const newValue = newValueWithEquals.startsWith("=") ? newValueWithEquals : "=" + newValueWithEquals;

  // Try single-line replacement first.
  const singleLineRe = new RegExp(
    `(^[ \\t]+${escapeRegExp(property)}:\\s+)=[^\\n]*$`,
    "m",
  );
  if (singleLineRe.test(yamlText)) {
    return yamlText.replace(singleLineRe, `$1${newValue}`);
  }

  // Multi-line block: `Property: |-` then indented lines until indent drops.
  const blockHeaderRe = new RegExp(
    `(^([ \\t]+)${escapeRegExp(property)}:\\s+\\|[-+]?\\s*\\n)((?:\\2[ \\t]+.*\\n?)+)`,
    "m",
  );
  const m = blockHeaderRe.exec(yamlText);
  if (m) {
    const [whole, header, indent, body] = m;
    // The first non-empty line of the body sets the inner indent.
    const firstBodyLine = body.split("\n").find(l => l.trim().length > 0) ?? "";
    const innerIndentMatch = firstBodyLine.match(/^([ \t]+)/);
    const innerIndent = innerIndentMatch ? innerIndentMatch[1] : `${indent}    `;
    // Re-indent the new value: prefix every line with innerIndent.
    const newBody = newValue
      .split("\n")
      .map(l => innerIndent + l)
      .join("\n") + "\n";
    return yamlText.replace(whole, header + newBody);
  }

  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// -----------------------------------------------------------------------------
// Power Fx YAML syntax validation (lightweight, pre-flight only)
// -----------------------------------------------------------------------------

export interface YamlValidationIssue {
  file: string;
  line: number;
  severity: "error" | "warning";
  message: string;
}

/**
 * Cheap pre-flight checks against the Power Fx YAML grammar:
 *   - Every property formula starts with `=` (or is a `|-` block whose first
 *     non-blank line starts with `=`)
 *   - Single-line formulas don't contain `#` or `:` outside of strings
 *     (because YAML reinterprets them — multi-line block required)
 *   - Top-level structure parses as YAML
 *
 * NOT a Power Fx semantic check — we don't have a Power Fx parser. For semantic
 * validation, the user falls back to `pac power-fx repl` or runs in Studio.
 */
export function validatePaYaml(text: string, file: string): YamlValidationIssue[] {
  const issues: YamlValidationIssue[] = [];

  // YAML parses?
  let parsed: unknown = null;
  try { parsed = yamlLoad(text); } catch (err) {
    issues.push({ file, line: 0, severity: "error", message: `YAML parse error: ${(err as Error).message}` });
    return issues;
  }
  if (!parsed || typeof parsed !== "object") {
    issues.push({ file, line: 0, severity: "error", message: "YAML root is not an object" });
    return issues;
  }

  // Line-level checks. Walk lines, track block-scalar state.
  const lines = text.split("\n");
  let inBlockScalar = false;
  let blockIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = (line.match(/^[ \t]*/) ?? [""])[0].length;

    // Track block-scalar continuation.
    if (inBlockScalar) {
      if (line.trim() === "" || indent > blockIndent) continue;
      inBlockScalar = false;
    }

    // Property line — `Name: <value>` or `Name: |-`.
    const m = line.match(/^([ \t]*)([A-Za-z_][\w]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, leadingWs, propName, rhs] = m;

    if (rhs === "" || rhs.startsWith("|") || rhs.startsWith(">")) {
      // Block scalar starts here, no validation on this line beyond the marker.
      if (rhs.startsWith("|") || rhs.startsWith(">")) {
        inBlockScalar = true;
        blockIndent = leadingWs.length;
      }
      continue;
    }
    if (rhs === "null") continue;

    // YAML allows quoted scalar strings (`Text: "=..."` or `Text: '=...'`). The string
    // CONTENT is still expected to start with `=` for a Power Fx formula, but our
    // line-level scanner can only see the RHS verbatim. If the RHS is a quoted string,
    // peek inside the quote to find the actual first non-whitespace char.
    const quotedMatch = rhs.match(/^(['"])([\s\S]*?)$/);
    if (quotedMatch) {
      const inner = quotedMatch[2].replace(/^\s*/, "");
      // A multi-line YAML double-quoted string can wrap with backslash-newline
      // continuations — but if even the first line's inner content starts with `=`,
      // we accept it. Below: only error when inner clearly doesn't start with `=`.
      if (inner.startsWith("=") || inner.startsWith(quotedMatch[1])) continue;
      // Empty quoted string → noop.
      if (inner.length === 0) continue;
      if (NON_FORMULA_KEYS.has(propName)) continue;
      issues.push({
        file, line: i + 1, severity: "error",
        message: `Property '${propName}' quoted value does not start with '=' (Power Fx YAML formulas must).`,
      });
      continue;
    }

    // Container-y property (children of a non-leaf): we look for nested object,
    // so RHS may also be empty. Skip if RHS is empty — already handled.
    // For LEAF properties (whose RHS is a value), enforce leading `=`.
    if (rhs.startsWith("=")) {
      // Forbidden chars in single-line formula. NB: we must exclude `:` inside string
      // literals from triggering the warning. Cheap check — if `=` is followed by a
      // string literal that contains the suspicious char, accept. A full Power Fx
      // tokenizer is overkill; this catches the common case where the formula contains
      // unquoted `#`/`:`.
      const formulaBody = rhs.slice(1);
      const stripped = formulaBody.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "");
      if (/#/.test(stripped) || /:/.test(stripped)) {
        issues.push({
          file,
          line: i + 1,
          severity: "warning",
          message:
            `Property '${propName}' single-line formula contains '#' or ':' which YAML reinterprets. ` +
            `Convert to a multi-line block with '|-' if the formula needs these characters.`,
        });
      }
      continue;
    }

    // Property has a non-empty RHS that doesn't start with `=` and isn't `null`/quoted/block.
    // That's malformed per the YAML formula grammar (could happen when someone
    // edits by hand and forgets the `=`).
    // BUT: schema metadata fields like `Control: Label`, `DefinitionType: CanvasComponent`
    // are not formulas. We skip a small allowlist of known non-formula keys.
    if (NON_FORMULA_KEYS.has(propName)) continue;

    issues.push({
      file,
      line: i + 1,
      severity: "error",
      message: `Property '${propName}' value '${rhs.slice(0, 40)}…' is missing the leading '=' that Power Fx YAML requires.`,
    });
  }

  return issues;
}

const NON_FORMULA_KEYS = new Set([
  "Control",
  "DefinitionType",
  "Description",
  "AllowCustomization",
  "Group",
  "Variant",
  "MetadataKey",
  "Layout",
  "IsLocked",
  "ComponentName",
  "ComponentLibraryUniqueName",
]);
