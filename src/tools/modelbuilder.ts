import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool } from "../runner.js";

export function registerModelBuilder(server: McpServer) {
  server.tool(
    "modelbuilder_build",
    "Generate strongly-typed C#/VB code (entities, messages, optionsets) from Dataverse metadata. Local code generation; reads metadata from the active env.",
    {
      out_directory: z.string().describe("Output directory for generated code"),
      language: z.enum(["CS", "VB"]).default("CS"),
      namespace: z.string().optional(),
      service_context_name: z.string().optional().describe("If set, generates a Service Context class"),
      generate_sdk_messages: z.boolean().default(false),
      emit_entity_etc: z.boolean().default(false),
      emit_virtual_attributes: z.boolean().default(false),
      emit_fields_classes: z.boolean().default(false),
      entity_names_filter: z.string().optional().describe("Semicolon-separated entity logical names; supports * wildcard"),
      message_names_filter: z.string().optional().describe("Semicolon-separated message names; supports * wildcard"),
      entity_types_folder: z.string().optional().describe("Folder for entity files (default 'Entities')"),
      messages_types_folder: z.string().optional(),
      optionsets_types_folder: z.string().optional(),
      generate_global_optionsets: z.boolean().default(false),
      suppress_generated_code_attribute: z.boolean().default(false),
      suppress_inotify_pattern: z.boolean().default(false),
      log_level: z.string().optional(),
      settings_template_file: z.string().optional(),
      write_settings_template_file: z.boolean().default(false),
      environment: z.string().optional(),
    },
    async (a) => {
      const args = ["modelbuilder", "build", "--outdirectory", a.out_directory, "--language", a.language];
      if (a.namespace) args.push("--namespace", a.namespace);
      if (a.service_context_name) args.push("--serviceContextName", a.service_context_name);
      if (a.generate_sdk_messages) args.push("--generatesdkmessages", "true");
      if (a.emit_entity_etc) args.push("--emitentityetc", "true");
      if (a.emit_virtual_attributes) args.push("--emitvirtualattributes", "true");
      if (a.emit_fields_classes) args.push("--emitfieldsclasses", "true");
      if (a.entity_names_filter) args.push("--entitynamesfilter", a.entity_names_filter);
      if (a.message_names_filter) args.push("--messagenamesfilter", a.message_names_filter);
      if (a.entity_types_folder) args.push("--entitytypesfolder", a.entity_types_folder);
      if (a.messages_types_folder) args.push("--messagestypesfolder", a.messages_types_folder);
      if (a.optionsets_types_folder) args.push("--optionsetstypesfolder", a.optionsets_types_folder);
      if (a.generate_global_optionsets) args.push("--generateGlobalOptionSets", "true");
      if (a.suppress_generated_code_attribute) args.push("--suppressGeneratedCodeAttribute", "true");
      if (a.suppress_inotify_pattern) args.push("--suppressINotifyPattern", "true");
      if (a.log_level) args.push("--logLevel", a.log_level);
      if (a.settings_template_file) args.push("--settingsTemplateFile", a.settings_template_file);
      if (a.write_settings_template_file) args.push("--writesettingsTemplateFile", "true");
      if (a.environment) args.push("--environment", a.environment);
      return runAsTool({ toolName: "modelbuilder_build", binary: "pac", args, timeoutMs: 30 * 60_000 });
    }
  );
}
