export interface Capability {
  name: string;
  description: string;
  available: boolean;
}

export const BLOB_CAPABILITIES: Capability[] = [
  {
    name: "conversation",
    description: "General conversation and answering questions",
    available: true,
  },
  {
    name: "coding",
    description: "Write, review, and refactor code",
    available: true,
  },
  {
    name: "repos",
    description: "Manage code repositories (add, list, set goals)",
    available: true,
  },
  {
    name: "agent",
    description: "Autonomous agent that works on tasks every 5 minutes",
    available: true,
  },
  {
    name: "slack",
    description: "Chat with you in Slack",
    available: true,
  },
  {
    name: "sandbox",
    description: "Execute commands safely in isolated container",
    available: true,
  },
  {
    name: "model_selection",
    description: "Intelligently select best AI model for each task",
    available: true,
  },
  {
    name: "memory",
    description: "Remember our conversations and your preferences",
    available: true,
  },
  {
    name: "github",
    description: "Push code changes to GitHub",
    available: true,
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
