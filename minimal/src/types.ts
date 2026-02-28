/**
 * Type definitions for minimal autonomous agent.
 */

export interface Env {
  // Cloudflare bindings
  AI?: unknown;
  CONFIG?: KVNamespace;
  
  // GitHub token for accessing repos
  GITHUB_TOKEN?: string;
  
  // AI Gateway
  AI_GATEWAY_TOKEN?: string;
  AI_GATEWAY_BASE_URL?: string;
}

export interface RepoConfig {
  goals: string[];
  owner: string;
  repo: string;
  isPrivate: boolean;
}

export interface AgentConfig {
  goals: string[];
  repo: string;  // owner/repo format
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
