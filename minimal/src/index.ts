/**
 * Multi-repo autonomous agent.
 * 
 * Philosophy:
 * - Works on multiple repositories
 * - Per-repository goals stored in KV
 * - Fully autonomous - no human in the loop
 * - Self-healing on errors
 */

import type { Env, AgentConfig, RepoConfig } from "./types";
import { callLLM, generatePlan, executeWithTools } from "./llm";
import { tools } from "./tools";

// Default repositories to work on
const DEFAULT_REPOS = ["kyleboas/blob"];

/**
 * Get list of all repositories being managed.
 */
async function getRepos(env: Env): Promise<string[]> {
  if (!env.CONFIG) return DEFAULT_REPOS;
  
  const reposList = await env.CONFIG.get("repos");
  if (reposList) {
    return reposList.split(",").map(r => r.trim()).filter(Boolean);
  }
  return DEFAULT_REPOS;
}

/**
 * Add a repository to the managed list.
 */
async function addRepo(env: Env, repo: string): Promise<void> {
  if (!env.CONFIG) return;
  
  const repos = await getRepos(env);
  if (!repos.includes(repo)) {
    repos.push(repo);
    await env.CONFIG.put("repos", repos.join(","));
  }
}

/**
 * Get goals for a specific repository.
 */
async function getRepoGoals(env: Env, repo: string): Promise<string[]> {
  if (!env.CONFIG) return ["improve codebase"];
  
  const key = `goals:${repo}`;
  const stored = await env.CONFIG.get(key);
  
  if (stored) {
    return stored.split(";").map(g => g.trim()).filter(Boolean);
  }
  
  // Default goals for new repos
  return ["improve code quality", "fix bugs", "add documentation"];
}

/**
 * Set goals for a specific repository.
 */
async function setRepoGoals(env: Env, repo: string, goals: string[]): Promise<void> {
  if (!env.CONFIG) return;
  
  const key = `goals:${repo}`;
  await env.CONFIG.put(key, goals.join("; "));
}

/**
 * Get all repository configs.
 */
async function getAllRepoConfigs(env: Env): Promise<Array<{ repo: string; goals: string[] }>> {
  const repos = await getRepos(env);
  const configs = [];
  
  for (const repo of repos) {
    const goals = await getRepoGoals(env, repo);
    configs.push({ repo, goals });
  }
  
  return configs;
}

export class AutonomousAgent {
  private config: AgentConfig;
  private env: Env;
  private toolResults: string[];

  constructor(config: AgentConfig, env: Env) {
    this.config = config;
    this.env = env;
    this.toolResults = [];
  }

  /**
   * Run one autonomous iteration: plan → execute → commit
   */
  async run(): Promise<{ task: string; result: string; repo: string } | { error: string; repo: string }> {
    this.toolResults = [];
    
    try {
      // 1. Plan what to work on
      const task = await this.plan();
      console.log(`[PLAN][${this.config.repo}] ${task}`);
      
      // 2. Execute the task
      const result = await this.execute(task);
      console.log(`[EXEC][${this.config.repo}] ${result}`);
      
      // 3. Auto-commit on success
      await this.commit(task, result);
      
      return { task, result, repo: this.config.repo };
    } catch (error) {
      const errorMsg = String(error);
      console.error(`[ERROR][${this.config.repo}] ${errorMsg}`);
      
      // 4. Self-heal on failure
      const healed = await this.selfHeal(errorMsg);
      if (healed) {
        return { task: "self-heal", result: "Recovered from error", repo: this.config.repo };
      }
      
      return { error: errorMsg, repo: this.config.repo };
    }
  }

  /**
   * Plan what to work on based on goals.
   */
  private async plan(): Promise<string> {
    return generatePlan(this.config.goals, this.env);
  }

  /**
   * Execute a task using tools in a loop.
   */
  private async execute(task: string): Promise<string> {
    const ctx = { env: this.env, repoPath: `/tmp/${this.config.repo}` };
    
    for (let step = 0; step < this.config.maxSteps; step++) {
      // Get next action from LLM
      const decision = await executeWithTools(task, this.toolResults, this.env);
      
      // Check if done
      if (typeof decision === "string") {
        return decision;
      }
      
      if ("done" in decision && decision.done) {
        const doneDecision = decision as { done: boolean; summary?: string };
        return doneDecision.summary ?? "Task completed";
      }
      
      // Execute tool
      const { tool, args } = decision as unknown as { tool: string; args: Record<string, unknown> };
      
      if (!(tool in tools)) {
        this.toolResults.push(`Error: Unknown tool "${tool}"`);
        continue;
      }
      
      try {
        const result = await tools[tool](args, ctx);
        this.toolResults.push(`[${tool}] ${result}`);
      } catch (error) {
        this.toolResults.push(`[${tool}] Error: ${error}`);
      }
    }
    
    return `Reached max steps (${this.config.maxSteps}). Last actions:\n${this.toolResults.join("\n")}`;
  }

  /**
   * Self-heal by creating a fix task.
   */
  private async selfHeal(error: string): Promise<boolean> {
    try {
      const fixTask = `Fix this error and complete the task: ${error}`;
      await this.execute(fixTask);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Auto-commit changes.
   */
  private async commit(task: string, _result: string): Promise<void> {
    if (!this.env.GITHUB_TOKEN) {
      console.log(`[COMMIT][${this.config.repo}] Skipped (no GITHUB_TOKEN)`);
      return;
    }
    
    // Create branch, commit, push, create PR
    const branchName = `auto/${Date.now()}`;
    console.log(`[COMMIT][${this.config.repo}] Would create branch ${branchName} for: ${task}`);
    
    // In real implementation:
    // 1. git checkout -b branchName
    // 2. git add .
    // 3. git commit -m "${task}"
    // 4. git push origin branchName
    // 5. gh pr create --title "${task}" --body "Autonomous change"
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === "/health") {
      return new Response("OK");
    }
    
    // List all repos and their goals
    if (url.pathname === "/repos" && request.method === "GET") {
      const configs = await getAllRepoConfigs(env);
      return new Response(JSON.stringify({ repos: configs }), {
        headers: { "content-type": "application/json" }
      });
    }
    
    // Add a new repository
    if (url.pathname === "/repos" && request.method === "POST") {
      const body = await request.json() as { repo: string };
      await addRepo(env, body.repo);
      return new Response(JSON.stringify({ status: "added", repo: body.repo }), {
        headers: { "content-type": "application/json" }
      });
    }
    
    // Get goals for a specific repo
    if (url.pathname.startsWith("/repos/") && url.pathname.endsWith("/goals") && request.method === "GET") {
      const repo = url.pathname.replace("/repos/", "").replace("/goals", "");
      const goals = await getRepoGoals(env, repo);
      return new Response(JSON.stringify({ repo, goals }), {
        headers: { "content-type": "application/json" }
      });
    }
    
    // Set goals for a specific repo
    if (url.pathname.startsWith("/repos/") && url.pathname.endsWith("/goals") && request.method === "POST") {
      const repo = url.pathname.replace("/repos/", "").replace("/goals", "");
      const body = await request.json() as { goals: string[] };
      await setRepoGoals(env, repo, body.goals);
      return new Response(JSON.stringify({ status: "saved", repo, goals: body.goals }), {
        headers: { "content-type": "application/json" }
      });
    }
    
    // Run on all repos
    if (url.pathname === "/run" && request.method === "POST") {
      const repos = await getRepos(env);
      
      // Run on each repo in parallel
      const promises = repos.map(async (repo) => {
        const goals = await getRepoGoals(env, repo);
        const agent = new AutonomousAgent({ goals, repo, maxSteps: 25 }, env);
        return agent.run();
      });
      
      // Don't await - run in background
      Promise.all(promises).catch(console.error);
      
      return new Response(JSON.stringify({ status: "started", repos }), {
        headers: { "content-type": "application/json" }
      });
    }
    
    // Run on specific repo
    if (url.pathname === "/run" && request.method === "POST") {
      const body = await request.json() as { repo?: string };
      const repo = body?.repo ?? "kyleboas/blob";
      const goals = await getRepoGoals(env, repo);
      
      const agent = new AutonomousAgent({ goals, repo, maxSteps: 25 }, env);
      
      // Run in background
      agent.run().catch(console.error);
      
      return new Response(JSON.stringify({ status: "started", repo }), {
        headers: { "content-type": "application/json" }
      });
    }
    
    return new Response("Not found", { status: 404 });
  },
  
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const repos = await getRepos(env);
    
    // Run on each repo sequentially to avoid rate limits
    for (const repo of repos) {
      const goals = await getRepoGoals(env, repo);
      const agent = new AutonomousAgent({ goals, repo, maxSteps: 25 }, env);
      await agent.run();
    }
  }
};
