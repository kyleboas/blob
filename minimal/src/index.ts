/**
 * Complete minimal autonomous agent.
 * 
 * Philosophy:
 * - 4 core tools (read, write, edit, bash)
 * - LLM decides what to do
 * - No human approval
 * - Self-healing on errors
 * - Runs on Cloudflare Workers with cron triggers
 */

import type { Env, AgentConfig } from "./types";
import { callLLM, generatePlan, executeWithTools } from "./llm";
import { tools } from "./tools";

/**
 * Get goals from KV storage or fallback to env vars.
 */
async function getGoals(env: Env): Promise<string[]> {
  if (env.CONFIG) {
    const stored = await env.CONFIG.get("goals");
    if (stored) {
      return stored.split(";").map(g => g.trim()).filter(Boolean);
    }
  }
  return env.GOALS?.split(";").map(g => g.trim()).filter(Boolean) ?? ["improve codebase"];
}

/**
 * Save goals to KV storage.
 */
async function setGoals(env: Env, goals: string[]): Promise<void> {
  if (env.CONFIG) {
    await env.CONFIG.put("goals", goals.join("; "));
  }
}

/**
 * Get repo from KV storage or fallback to env vars.
 */
async function getRepo(env: Env): Promise<string> {
  if (env.CONFIG) {
    const stored = await env.CONFIG.get("repo");
    if (stored) return stored;
  }
  return env.REPO ?? "kyleboas/blob";
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
  async run(): Promise<{ task: string; result: string } | { error: string }> {
    this.toolResults = [];
    
    try {
      // 1. Plan what to work on
      const task = await this.plan();
      console.log(`[PLAN] ${task}`);
      
      // 2. Execute the task
      const result = await this.execute(task);
      console.log(`[EXEC] ${result}`);
      
      // 3. Auto-commit on success
      await this.commit(task, result);
      
      return { task, result };
    } catch (error) {
      const errorMsg = String(error);
      console.error(`[ERROR] ${errorMsg}`);
      
      // 4. Self-heal on failure
      const healed = await this.selfHeal(errorMsg);
      if (healed) {
        return { task: "self-heal", result: "Recovered from error" };
      }
      
      return { error: errorMsg };
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
      console.log("[COMMIT] Skipped (no GITHUB_TOKEN)");
      return;
    }
    
    // Create branch, commit, push, create PR
    const branchName = `auto/${Date.now()}`;
    console.log(`[COMMIT] Would create branch ${branchName} for: ${task}`);
    
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
    
    // Get current goals
    if (url.pathname === "/goals" && request.method === "GET") {
      const goals = await getGoals(env);
      return new Response(JSON.stringify({ goals }), {
        headers: { "content-type": "application/json" }
      });
    }
    
    // Update goals
    if (url.pathname === "/goals" && request.method === "POST") {
      const body = await request.json() as { goals: string[] };
      await setGoals(env, body.goals);
      return new Response(JSON.stringify({ status: "saved", goals: body.goals }), {
        headers: { "content-type": "application/json" }
      });
    }
    
    if (url.pathname === "/run" && request.method === "POST") {
      const goals = await getGoals(env);
      const repo = await getRepo(env);
      
      const agent = new AutonomousAgent({ goals, repo, maxSteps: 25 }, env);
      
      // Run in background
      const runPromise = agent.run().catch(console.error);
      
      return new Response(JSON.stringify({ status: "started" }), {
        headers: { "content-type": "application/json" }
      });
    }
    
    return new Response("Not found", { status: 404 });
  },
  
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const goals = await getGoals(env);
    const repo = await getRepo(env);
    
    const agent = new AutonomousAgent({ goals, repo, maxSteps: 25 }, env);
    await agent.run();
  }
};
