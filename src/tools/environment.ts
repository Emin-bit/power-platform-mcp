import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runAsTool } from "../runner.js";

export function registerEnvironment(server: McpServer) {
  server.tool(
    "env_who",
    "Show details of the active environment for the current PAC auth profile (user, environment, tenant, base URL). PAC returns this as text — there is no JSON mode.",
    {},
    async () => runAsTool({
      toolName: "env_who",
      binary: "pac",
      args: ["env", "who"],
      timeoutMs: 30_000,
    })
  );

  server.tool(
    "env_list",
    "List Dataverse environments visible to the current authenticated user via the Global Discovery Service. Use admin_env_list for tenant-wide listing (requires admin permissions).",
    {
      filter: z.string().optional().describe("Substring filter on environment name/URL"),
    },
    async ({ filter }) => {
      const args = ["env", "list"];
      if (filter) args.push("--filter", filter);
      return runAsTool({
        toolName: "env_list",
        binary: "pac",
        args,
        timeoutMs: 60_000,
      });
    }
  );

  server.tool(
    "env_select",
    "Set the default environment for the current PAC auth profile. Subsequent commands run against this environment unless they specify --environment.",
    {
      environment: z.string().describe("Environment URL (e.g. https://yourorg.crm4.dynamics.com) or environment ID (GUID)"),
    },
    async ({ environment }) => runAsTool({
      toolName: "env_select",
      binary: "pac",
      args: ["env", "select", "--environment", environment],
      timeoutMs: 30_000,
      hint: "Run env_who to confirm the new active environment.",
    })
  );

  server.tool(
    "env_list_settings",
    "List environment settings for the active (or specified) Dataverse environment.",
    {
      environment: z.string().optional().describe("Override environment URL or ID; defaults to active"),
      filter: z.string().optional().describe("Substring filter on setting names"),
    },
    async ({ environment, filter }) => {
      const args = ["env", "list-settings"];
      if (environment) args.push("--environment", environment);
      if (filter) args.push("--filter", filter);
      return runAsTool({
        toolName: "env_list_settings",
        binary: "pac",
        args,
        timeoutMs: 60_000,
      });
    }
  );

  server.tool(
    "env_fetch",
    "Run a FetchXML query against the active (or specified) Dataverse environment. Returns result as text (Dataverse Web API does not return tabular data via PAC, just text dump). " +
    "Pass either `xml` (inline FetchXML — auto-written to a temp file internally) or `xml_file` (path to a .xml file). " +
    "PAC quirks worth knowing: (a) PAC's `--xml` inline arg crashes with XmlException on some inputs, so MCP routes inline xml through a temp file using `--xmlFile` instead; (b) `<fetch top='N'>` errors with paging conflict, use `count='N'` if you need a limit; (c) PAC pages through ALL results regardless of `count` — limit on the FetchXML side or accept full output. " +
    "Phase E (1.2.0): pre-flight XML well-formedness check + better hints on common failure patterns.",
    {
      xml: z.string().optional().describe("Inline FetchXML query string (auto-written to temp file). Use this OR xml_file."),
      xml_file: z.string().optional().describe("Path to a .xml file containing the FetchXML query"),
      environment: z.string().optional().describe("Override environment URL or ID; defaults to active"),
    },
    async ({ xml, xml_file, environment }) => {
      if (!xml && !xml_file) {
        return {
          isError: true,
          content: [{ type: "text", text: "Pass either 'xml' (inline FetchXML) or 'xml_file' (path to file)." }],
        };
      }
      if (xml && xml_file) {
        return {
          isError: true,
          content: [{ type: "text", text: "Pass only one of 'xml' or 'xml_file', not both." }],
        };
      }

      // E3 fix: validate xml_file existence BEFORE spawning pac. Previously a typo'd path
      // produced a generic exit-1 from pac with stderr buried in the response; now we
      // catch it client-side with a clear actionable message.
      if (xml_file) {
        if (!existsSync(xml_file)) {
          return {
            isError: true,
            content: [{ type: "text", text: `xml_file does not exist: ${xml_file}` }],
          };
        }
      }

      // E3 fix: cheap pre-flight on inline XML. We don't run a full XML parser (overkill);
      // we just check the two well-known footguns that produced 24% of historical failures:
      //   (1) `<fetch top='N'>` triggers Dataverse "paging conflict" — common copy-paste mistake.
      //   (2) Missing root <fetch> element — pac surfaces this as cryptic XmlException.
      if (xml) {
        const trimmed = xml.trim();
        if (!/^<\?xml|^<fetch/i.test(trimmed)) {
          return {
            isError: true,
            content: [{
              type: "text",
              text:
                "FetchXML must start with `<?xml ...?>` or `<fetch ...>`. " +
                "Got: " + trimmed.slice(0, 80).replace(/\n/g, "\\n") + "…",
            }],
          };
        }
        const topAttr = /<fetch\s[^>]*\btop\s*=\s*['"]\d+['"]/i.exec(trimmed);
        if (topAttr) {
          return {
            isError: true,
            content: [{
              type: "text",
              text:
                "FetchXML uses `<fetch top='N'>`, which Dataverse rejects with a paging conflict via PAC's fetch command. " +
                "Use `<fetch count='N'>` instead (PAC still pages through all results, so `count` is a per-page hint, not a total cap).",
            }],
          };
        }
      }

      // If user passed inline `xml`, write it to a temp file and use --xmlFile.
      // PAC's --xml inline arg has a known XmlException crash on certain inputs;
      // --xmlFile is the reliable path.
      let tempPath: string | undefined;
      if (xml) {
        tempPath = join(tmpdir(), `pac-mcp-fetch-${randomBytes(4).toString("hex")}.xml`);
        try {
          writeFileSync(tempPath, xml, "utf8");
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to write FetchXML to temp file ${tempPath}: ${(err as Error).message}` }],
          };
        }
      }

      const filePath = xml_file ?? tempPath!;
      const args = ["env", "fetch", "--xmlFile", filePath];
      if (environment) args.push("--environment", environment);

      try {
        const result = await runAsTool({
          toolName: "env_fetch",
          binary: "pac",
          args,
          timeoutMs: 120_000,
        });
        // E3 fix: enrich the response with actionable hints when pac's stderr matches
        // known failure patterns. Doesn't change the raw output — appends a hint section
        // so Claude can take the right corrective action without re-googling PAC quirks.
        if (result.isError) {
          const text = result.content[0]?.text ?? "";
          const hints: string[] = [];
          if (/paging.*conflict|top.*count/i.test(text)) {
            hints.push("Hint: replace `top='N'` with `count='N'` in your FetchXML.");
          }
          if (/Could not connect|authentication|auth.*expired|401/i.test(text)) {
            hints.push("Hint: re-run `auth_list` and `auth_select`, or `auth_create --deviceCode` if the active profile expired.");
          }
          if (/XmlException|invalid xml|malformed/i.test(text)) {
            hints.push("Hint: PAC's XML parser is strict — check for unbalanced tags, smart quotes, or missing namespace declarations.");
          }
          if (/Entity .* doesn.?t exist|table .* not.found/i.test(text)) {
            hints.push("Hint: the entity logical name (e.g. `systemuser`, not `SystemUser`) must be all lowercase. Use `pacx_table_print` to list available entities.");
          }
          if (hints.length) {
            result.content[0] = {
              ...result.content[0],
              type: "text",
              text: text + "\n\n--- hints ---\n" + hints.join("\n"),
            };
          }
        }
        return result;
      } finally {
        if (tempPath) {
          try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
        }
      }
    }
  );
}
