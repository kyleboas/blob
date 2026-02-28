export interface Capability {
  name: string;
  description: string;
  available: boolean;
}

export const BLOB_CAPABILITIES: Capability[] = [
  {
    name: "repos",
    description: "Manage repositories (add, list, set goals)",
    available: true,
  },
  {
    name: "agent",
    description: "Autonomous agent that runs every 5 minutes on configured repos",
    available: true,
  },
  {
    name: "slack",
    description: "Respond to messages in Slack",
    available: true,
  },
  {
    name: "sandbox",
    description: "Execute bash commands in isolated Cloudflare Container",
    available: false, // Will be true if BLOB_SANDBOX is configured
  },
  {
    name: "model_selection",
    description: "Automatically select best AI model for task complexity",
    available: true,
  },
  {
    name: "model_catalog",
    description: "Weekly auto-update of available AI models from Cloudflare",
    available: true,
  },
  {
    name: "memory",
    description: "Persistent conversation history and user preferences",
    available: true,
  },
  {
    name: "github",
    description: "Auto-commit changes to repositories (requires GITHUB_TOKEN)",
    available: false, // Will be true if GITHUB_TOKEN is set
  },
];

export function getCapabilitiesDescription(env?: { BLOB_SANDBOX?: unknown; GITHUB_TOKEN?: string }): string {
  const caps = BLOB_CAPABILITIES.map(c => {
    let available = c.available;
    
    // Check runtime conditions
    if (c.name === "sandbox" && env?.BLOB_SANDBOX) available = true;
    if (c.name === "github" && env?.GITHUB_TOKEN) available = true;
    
    const status = available ? "✅" : "❌";
    return `${status} **${c.name}**: ${c.description}`;
  });
  
  return "My capabilities:\n\n" + caps.join("\n");
}

export function getAvailableTools(): string[] {
  return ["read", "write", "edit", "bash"];
}

export function getSystemPromptWithCapabilities(basePrompt: string, env?: { BLOB_SANDBOX?: unknown; GITHUB_TOKEN?: string }): string {
  return `${basePrompt}

${getCapabilitiesDescription(env)}

Available tools: ${getAvailableTools().join(", ")}

When asked what you can do, reference these capabilities.`;
}
