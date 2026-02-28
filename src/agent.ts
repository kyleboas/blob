import type { Env } from "./types";
import { plan } from "./llm";

export class Agent {
  constructor(private repo: string, private goals: string[], private env: Env) {}

  async run(): Promise<void> {
    try {
      const task = await plan(this.goals, this.env);
      console.log(`[${this.repo}] Task: ${task}`);
      
      // Execute task (simplified - just log for now)
      console.log(`[${this.repo}] Executing...`);
      
      // Auto-commit
      await this.commit(task);
    } catch (err) {
      console.error(`[${this.repo}] Error: ${err}`);
    }
  }

  private async commit(task: string): Promise<void> {
    if (!this.env.GITHUB_TOKEN) {
      console.log(`[${this.repo}] No GITHUB_TOKEN, skipping commit`);
      return;
    }
    console.log(`[${this.repo}] Would commit: ${task}`);
    // TODO: Implement actual git operations
  }
}
