import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { backgroundResult } from "../jobs.js";

const bg = (name: string, args: string[]) => backgroundResult(name, "pacx", args);

const WorkflowCategory = z.enum([
  "Worfklow", // PACX uses this typo intentionally — keep it
  "Dialog",
  "BusinessRule",
  "Action",
  "BusinessProcessFlow",
  "ModernFlow", // Power Automate cloud flows
  "DesktopFlow",
  "AIFlow",
]);

export function registerPacxMisc(server: McpServer) {
  // ============ publish ============
  server.tool(
    "pacx_publish_all",
    "Publish all customizations in the active PACX environment. Equivalent to pac solution_publish but uses PACX session/profile. Required after table/column/optionset changes to make them visible to users. " +
    "Often exceeds 60s; set background=true to bypass MCP transport timeout.",
    {
      background: z.boolean().default(false),
    },
    async ({ background }) => {
      const args = ["publish", "all"];
      if (background) return bg("pacx_publish_all", args);
      return runAsTool({
        toolName: "pacx_publish_all", binary: "pacx",
        args, timeoutMs: 15 * 60_000,
      });
    }
  );

  // ============ history ============
  server.tool(
    "pacx_history_get",
    "Get PACX command history (commands executed in past PACX sessions on this machine). Useful to recall what was done.",
    {
      length: z.number().int().positive().optional().describe("Limit to last N commands"),
      file: z.string().optional().describe("Save to file instead of returning"),
    },
    async ({ length, file }) => {
      const args = ["history", "get"];
      if (length !== undefined) args.push("--length", String(length));
      if (file) args.push("--file", file);
      return runAsTool({ toolName: "pacx_history_get", binary: "pacx", args, timeoutMs: 30_000 });
    }
  );

  server.tool(
    "pacx_history_clear",
    "Clear the PACX command history on this machine.",
    {
      confirm: z.boolean(),
    },
    async ({ confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pacx_history_clear wipes the history. Re-call with confirm=true." }] };
      return runAsTool({
        toolName: "pacx_history_clear", binary: "pacx",
        args: ["history", "clear"], timeoutMs: 15_000,
      });
    }
  );

  server.tool(
    "pacx_history_set_length",
    "Set how many commands PACX retains in history.",
    {
      length: z.number().int().nonnegative().describe("Number of commands to keep (0 = unlimited / disabled)"),
    },
    async ({ length }) => runAsTool({
      toolName: "pacx_history_set_length", binary: "pacx",
      args: ["history", "setLength", "--length", String(length)],
      timeoutMs: 15_000,
    })
  );

  // ============ workflow ============
  server.tool(
    "pacx_workflow_list",
    "USE THIS to list flows / classic workflows / business rules / BPF / desktop flows / AI flows. ⚠️ PAC has NO equivalent direct workflow listing tool. Optionally filter by name, category, or solution.",
    {
      name: z.string().optional().describe("Substring filter on workflow unique name"),
      category: WorkflowCategory.optional().describe("Filter by workflow category"),
      solution: z.string().optional().describe("Solution unique name (default: PACX default solution; pass '*' to disable filter)"),
    },
    async ({ name, category, solution }) => {
      const args = ["workflow", "list"];
      if (name) args.push("--name", name);
      if (category) args.push("--category", category);
      if (solution) args.push("--solution", solution);
      return runAsTool({ toolName: "pacx_workflow_list", binary: "pacx", args, timeoutMs: 60_000 });
    }
  );

  server.tool(
    "pacx_workflow_activate",
    "USE THIS for batch flow/workflow activation. ⚠️ PAC has NO equivalent. Pass either id (single workflow) or name (substring match — can affect multiple) optionally scoped by solution. Set background=true for batch activations that may exceed 60s.",
    {
      id: z.string().optional().describe("Workflow ID (GUID)"),
      name: z.string().optional().describe("Workflow unique name"),
      solution: z.string().optional(),
      background: z.boolean().default(false),
    },
    async ({ id, name, solution, background }) => {
      if (!id && !name) {
        return { isError: true, content: [{ type: "text", text: "Pass id or name." }] };
      }
      const args = ["workflow", "activate"];
      if (id) args.push("--id", id);
      if (name) args.push("--name", name);
      if (solution) args.push("--solution", solution);
      if (background) return bg("pacx_workflow_activate", args);
      return runAsTool({ toolName: "pacx_workflow_activate", binary: "pacx", args, timeoutMs: 5 * 60_000 });
    }
  );

  server.tool(
    "pacx_workflow_deactivate",
    "USE THIS for batch flow/workflow deactivation. ⚠️ PAC has NO equivalent. Set background=true for batch deactivations that may exceed 60s.",
    {
      id: z.string().optional(),
      name: z.string().optional(),
      solution: z.string().optional(),
      background: z.boolean().default(false),
    },
    async ({ id, name, solution, background }) => {
      if (!id && !name) {
        return { isError: true, content: [{ type: "text", text: "Pass id or name." }] };
      }
      const args = ["workflow", "deactivate"];
      if (id) args.push("--id", id);
      if (name) args.push("--name", name);
      if (solution) args.push("--solution", solution);
      if (background) return bg("pacx_workflow_deactivate", args);
      return runAsTool({ toolName: "pacx_workflow_deactivate", binary: "pacx", args, timeoutMs: 5 * 60_000 });
    }
  );
}
