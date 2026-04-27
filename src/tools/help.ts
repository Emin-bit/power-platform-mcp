import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runPac, type PacBinary } from "../pac.js";
import { parseShellArgs } from "../shell.js";
import { log } from "../logger.js";

export function registerHelp(server: McpServer) {
  for (const binary of ["pac", "pacx"] as const satisfies readonly PacBinary[]) {
    server.tool(
      `${binary}_help`,
      `Get help text from '${binary}' for any subcommand or namespace. ` +
      `Pass an empty string for top-level help (lists all verbs), or a path like "solution" for namespace help, or "solution import" for leaf-command help with all flags. ` +
      `Use this whenever you are unsure which subcommands or flags exist — '${binary}' evolves and this is the source of truth. ` +
      (binary === "pac"
        ? `⚠️ For Dataverse table/column/optionset/key/relationship/view metadata operations, ALSO check pacx_help — PAC does not cover those domains. When the user's request is ambiguous about data-model ops, query both pac_help and pacx_help before choosing a tool.`
        : `⚠️ For solution lifecycle (import/export/pack/unpack/check), env management, canvas/pages/PCF/plugin operations, ALSO check pac_help — PACX focuses on Dataverse data model and metadata, not those domains.`),
      {
        path: z.string().default("").describe(`Subcommand path. Examples: "" (top), "solution", "env", "solution import", "auth create"`),
      },
      async ({ path }) => {
        const tokens = path.trim() ? parseShellArgs(path) : [];
        // PAC/PACX prefer the 'help' subverb over '--help' flag — '--help' triggers
        // an "Unneeded argument was passed" header before the actual usage. Using
        // 'help' as a subverb produces clean output. Empty path → 'pac help' (top-level).
        const argv = [...tokens, "help"];
        log("info", `${binary}_help`, { path });
        try {
          const r = await runPac({ binary, args: argv, timeoutMs: 30_000 });
          const text = (r.stdout || r.stderr || "(no output)").trimEnd();
          return {
            isError: r.exitCode !== 0 && !r.stdout.trim(),
            content: [{ type: "text", text }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: (err as Error).message }],
          };
        }
      }
    );
  }
}
