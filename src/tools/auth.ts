import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runPac, maskInOutput } from "../pac.js";
import { log } from "../logger.js";

function textResult(stdout: string, stderr: string, exitCode: number, redact: string[] = []) {
  const raw = (stdout.trim() || stderr.trim() || "(no output)").trimEnd();
  return {
    isError: exitCode !== 0,
    content: [{ type: "text" as const, text: maskInOutput(raw, redact) }],
  };
}

export function registerAuth(server: McpServer) {
  server.tool(
    "whoami",
    "Show the active PAC auth profile, tenant, user, and connected environment. ALWAYS call this before any destructive operation to verify the context (which tenant/environment will be affected).",
    {},
    async () => {
      log("info", "whoami");
      try {
        const auth = await runPac({ binary: "pac", args: ["auth", "list"], timeoutMs: 15_000 });
        const org = await runPac({ binary: "pac", args: ["org", "who"], timeoutMs: 30_000 });
        const text = [
          "=== pac auth list ===",
          (auth.stdout || auth.stderr || "(no output)").trimEnd(),
          "",
          "=== pac org who ===",
          (org.stdout || org.stderr || "(no output)").trimEnd(),
        ].join("\n");
        return {
          isError: auth.exitCode !== 0 && org.exitCode !== 0,
          content: [{ type: "text", text }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
      }
    }
  );

  server.tool(
    "auth_list",
    "List all PAC auth profiles configured on this machine, with index numbers used by auth_select and auth_delete.",
    {},
    async () => {
      log("info", "auth_list");
      try {
        const r = await runPac({ binary: "pac", args: ["auth", "list"], timeoutMs: 15_000 });
        return textResult(r.stdout, r.stderr, r.exitCode);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
      }
    }
  );

  server.tool(
    "auth_select",
    "Switch the active PAC auth profile by its index from auth_list. Subsequent pac/pacx commands will run against this profile's tenant and environment.",
    {
      index: z.number().int().nonnegative().describe("Profile index from auth_list output"),
    },
    async ({ index }) => {
      log("info", "auth_select", { index });
      try {
        const r = await runPac({ binary: "pac", args: ["auth", "select", "--index", String(index)], timeoutMs: 15_000 });
        return textResult(r.stdout, r.stderr, r.exitCode);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
      }
    }
  );

  server.tool(
    "auth_delete",
    "DESTRUCTIVE: delete an auth profile by index. Requires confirm=true. Does not affect the underlying Service Principal or user account, only the local PAC profile.",
    {
      index: z.number().int().nonnegative().describe("Profile index from auth_list"),
      confirm: z.boolean().describe("Must be true to proceed"),
    },
    async ({ index, confirm }) => {
      if (!confirm) {
        return {
          isError: true,
          content: [{ type: "text", text: "BLOCKED: pass confirm=true to delete the auth profile." }],
        };
      }
      log("info", "auth_delete", { index });
      try {
        const r = await runPac({ binary: "pac", args: ["auth", "delete", "--index", String(index)], timeoutMs: 15_000 });
        return textResult(r.stdout, r.stderr, r.exitCode);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
      }
    }
  );

  server.tool(
    "auth_create_service_principal",
    "Create a new auth profile using a Service Principal (Entra app registration) with a CLIENT SECRET. The secret is forwarded directly to PAC and stored in PAC's encrypted profile store. The MCP server never persists or logs the secret.",
    {
      tenant: z.string().describe("Tenant ID (GUID) or domain (e.g. contoso.onmicrosoft.com)"),
      application_id: z.string().describe("Service Principal Application (client) ID — GUID"),
      client_secret: z.string().describe("Service Principal client secret"),
      environment: z.string().optional().describe("Target environment URL or ID to bind this profile to (optional)"),
      name: z.string().optional().describe("Friendly profile name (optional)"),
    },
    async ({ tenant, application_id, client_secret, environment, name }) => {
      const args = [
        "auth", "create",
        "--tenant", tenant,
        "--applicationId", application_id,
        "--clientSecret", client_secret,
      ];
      if (environment) args.push("--environment", environment);
      if (name) args.push("--name", name);
      log("info", "auth_create_service_principal", { tenant, application_id, environment, name });
      try {
        const r = await runPac({ binary: "pac", args, timeoutMs: 60_000 });
        return textResult(r.stdout, r.stderr, r.exitCode, [client_secret]);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
      }
    }
  );

  server.tool(
    "auth_create_service_principal_cert",
    "Create a new auth profile using a Service Principal with a CERTIFICATE file (.pfx). The certificate file path is passed to PAC; the optional password is stored in PAC's profile.",
    {
      tenant: z.string().describe("Tenant ID (GUID) or domain"),
      application_id: z.string().describe("Service Principal Application (client) ID"),
      certificate_file_path: z.string().describe("Absolute path to the .pfx certificate file"),
      certificate_password: z.string().optional().describe("Certificate password (if the .pfx is protected)"),
      environment: z.string().optional().describe("Target environment URL or ID"),
      name: z.string().optional().describe("Friendly profile name"),
    },
    async ({ tenant, application_id, certificate_file_path, certificate_password, environment, name }) => {
      const args = [
        "auth", "create",
        "--tenant", tenant,
        "--applicationId", application_id,
        "--certificateFilePath", certificate_file_path,
      ];
      if (certificate_password) args.push("--certificatePassword", certificate_password);
      if (environment) args.push("--environment", environment);
      if (name) args.push("--name", name);
      log("info", "auth_create_service_principal_cert", { tenant, application_id, environment, name });
      try {
        const r = await runPac({ binary: "pac", args, timeoutMs: 60_000 });
        return textResult(r.stdout, r.stderr, r.exitCode, certificate_password ? [certificate_password] : []);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
      }
    }
  );

  server.tool(
    "auth_create_device_code",
    "Start a device-code login flow. Returns a verification URL and code that the END USER must enter in their browser. After the user approves, PAC stores the resulting profile. Long timeout (10 min) to allow for user action — call whoami afterwards to confirm success.",
    {
      environment: z.string().optional().describe("Target environment URL or ID"),
      name: z.string().optional().describe("Friendly profile name"),
    },
    async ({ environment, name }) => {
      const args = ["auth", "create", "--deviceCode"];
      if (environment) args.push("--environment", environment);
      if (name) args.push("--name", name);
      log("info", "auth_create_device_code", { environment, name });
      try {
        const r = await runPac({ binary: "pac", args, timeoutMs: 600_000 });
        return textResult(r.stdout, r.stderr, r.exitCode);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
      }
    }
  );

  server.tool(
    "auth_create_interactive",
    "Start an interactive browser login. Opens the system browser for the user to sign in. Use this on a developer workstation — NOT on a headless server (use device code or service principal there).",
    {
      environment: z.string().optional().describe("Target environment URL or ID"),
      name: z.string().optional().describe("Friendly profile name"),
    },
    async ({ environment, name }) => {
      const args = ["auth", "create"];
      if (environment) args.push("--environment", environment);
      if (name) args.push("--name", name);
      log("info", "auth_create_interactive", { environment, name });
      try {
        const r = await runPac({ binary: "pac", args, timeoutMs: 600_000 });
        return textResult(r.stdout, r.stderr, r.exitCode);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
      }
    }
  );
}
