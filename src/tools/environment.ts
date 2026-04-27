import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, unlinkSync } from "node:fs";
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
    "PAC quirks worth knowing: (a) PAC's `--xml` inline arg crashes with XmlException on some inputs, so MCP routes inline xml through a temp file using `--xmlFile` instead; (b) `<fetch top='N'>` errors with paging conflict, use `count='N'` if you need a limit; (c) PAC pages through ALL results regardless of `count` — limit on the FetchXML side or accept full output.",
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
        return await runAsTool({
          toolName: "env_fetch",
          binary: "pac",
          args,
          timeoutMs: 120_000,
        });
      } finally {
        if (tempPath) {
          try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
        }
      }
    }
  );
}
