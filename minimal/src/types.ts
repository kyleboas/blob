/**
 * Type definitions for minimal autonomous agent.
 */

export interface Env {
  // Cloudflare bindings
  AI?: unknown;
  CONFIG?: KVNamespace;
  
  // Configuration (fallback defaults)
  GOALS?: string;
  REPO?: string;
  GITHUB_TOKEN?: string;
  
  // AI Gateway
  AI_GATEWAY_TOKEN?: string;
  AI_GATEWAY_BASE_URL?: string;
}

export interface AgentConfig {
  goals: string[];
  repo: string;
  maxSteps: number;
}

export interface Tool {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface ToolContext {
  env: Env;
  repoPath: string;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
