import { TOOL_OUTPUT_MAX_CHARS } from "./config";
import type { ToolResult } from "./types";

export interface DynamicToolDefinition {
  name: string;
  description: string;
  commandTemplate: string;
  args: string[];
}

export const BASH_TOOL = {
  name: "bash",
  description: "Execute a bash command inside the configured sandbox.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute"
      }
    },
    required: ["command"]
  }
} as const;

export const CREATE_TOOL_TOOL = {
  name: "create_tool",
  description: "Create a reusable command tool. Use this when the same shell workflow will be run repeatedly.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Tool name in snake_case, e.g. list_repo_files" },
      description: { type: "string", description: "What the tool does and when to use it" },
      command_template: { type: "string", description: "Bash command template. Use {arg_name} placeholders for arguments." },
      args: {
        type: "array",
        description: "Argument names used by command_template placeholders",
        items: { type: "string" }
      }
    },
    required: ["name", "description", "command_template"],
    additionalProperties: false
  }
} as const;

export const WEB_FETCH_TOOL = {
  name: "web_fetch",
  description: "Fetch a web page and return its content as markdown. Use this to read web pages. Returns only text content, no scripts or styles.",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to fetch (must be http or https)"
      },
      max_length: {
        type: "number",
        description: "Maximum characters to return (default 4000)"
      }
    },
    required: ["url"]
  }
} as const;

export const WEATHER_TOOL = {
  name: "weather",
  description: "Get current weather for a location. Uses wttr.in free weather service. Pass location as city name or 'lat,lon' coordinates.",
  input_schema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name (e.g. 'London', 'New York', 'Shanghai') or coordinates (e.g. '31.2304,121.4737')"
      }
    },
    required: ["location"]
  }
} as const;

export const SQL_QUERY_TOOL = {
  name: "sql_query",
  description: "Execute a SQL query against the persistent SQLite storage. Use this to read or modify settings, knowledge, conversation history, heartbeats, agent events, and other stored data. SELECT queries return rows as JSON. INSERT/UPDATE/DELETE returns affected row count. Available tables: conversation_messages, agent_state, rate_limits, approval_log, knowledge, settings, extensions, session_nodes, agent_events, session_state, session_summaries, heartbeats, sub_agents, operator_feedback.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "SQL query to execute (SELECT, INSERT, UPDATE, or DELETE)"
      }
    },
    required: ["query"]
  }
} as const;

export const KV_GET_TOOL = {
  name: "kv_get",
  description: "Read a value from Cloudflare KV storage. Use this to inspect user configuration, repository goals, preferences, and other KV-stored data. Pass 'user-configuration' to read the main user config.",
  input_schema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "KV key to read (e.g. 'user-configuration')"
      }
    },
    required: ["key"]
  }
} as const;

export const KV_PUT_TOOL = {
  name: "kv_put",
  description: "Write a value to Cloudflare KV storage. Use this to update user configuration, repository goals, preferences, and other KV-stored data.",
  input_schema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "KV key to write"
      },
      value: {
        type: "string",
        description: "Value to store (use JSON for structured data)"
      }
    },
    required: ["key", "value"]
  }
} as const;

export function sanitizeToolName(rawName: string): string {
  return rawName.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

export function validateDynamicToolDefinition(input: Record<string, unknown>): { ok: true; definition: DynamicToolDefinition } | { ok: false; reason: string } {
  const rawName = String(input.name ?? "").trim();
  const description = String(input.description ?? "").trim();
  const commandTemplate = String(input.command_template ?? "").trim();
  const providedArgs = Array.isArray(input.args) ? input.args.map((arg) => String(arg).trim()).filter(Boolean) : [];

  if (!rawName || !description || !commandTemplate) {
    return { ok: false, reason: "name, description, and command_template are required." };
  }

  const name = sanitizeToolName(rawName);
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) {
    return { ok: false, reason: "Tool name must start with a letter and contain only lowercase letters, numbers, or underscores (2-64 chars)." };
  }

  if (name === "bash" || name === "create_tool") {
    return { ok: false, reason: `Tool name \"${name}\" is reserved.` };
  }

  const placeholderArgs = Array.from(commandTemplate.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)).map((match) => match[1]);
  const args = Array.from(new Set([...providedArgs, ...placeholderArgs]));

  return {
    ok: true,
    definition: {
      name,
      description,
      commandTemplate,
      args
    }
  };
}

export function dynamicToolToAnthropicSchema(tool: DynamicToolDefinition) {
  const properties = Object.fromEntries(tool.args.map((arg) => [arg, { type: "string", description: `${arg} value` }]));

  return {
    name: tool.name,
    description: `${tool.description} (Generated by Blob during this session)`,
    input_schema: {
      type: "object",
      properties,
      required: tool.args,
      additionalProperties: false
    }
  };
}

export function compileDynamicToolCommand(tool: DynamicToolDefinition, input: Record<string, unknown>): { ok: true; command: string } | { ok: false; reason: string } {
  let command = tool.commandTemplate;
  for (const arg of tool.args) {
    const value = input[arg];
    if (value === undefined || value === null) {
      return { ok: false, reason: `Missing required argument: ${arg}` };
    }
    command = command.replaceAll(`{${arg}}`, String(value));
  }

  return { ok: true, command };
}

export function formatToolResult(toolUseId: string, output: string, maxChars = TOOL_OUTPUT_MAX_CHARS): ToolResult {
  const trimmed = output.length > maxChars
    ? `${output.slice(0, maxChars)}\n\n[output truncated: ${output.length - maxChars} characters omitted]`
    : output;

  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [{ type: "text", text: trimmed }]
  };
}
