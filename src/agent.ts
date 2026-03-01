import type { Env } from "./types";
import { plan, runWithTools } from "./llm";

export class Agent {
  constructor(private repo: string, private goals: string[], private env: Env) {}

  async run(): Promise<void> {
    try {
      const task = await plan(this.goals, this.env);
      const result = await runWithTools(task, this.env, { instanceId: this.repo });
      console.log(`[${this.repo}] ${result}`);
      await this.commit(task);
    } catch (err) {
      console.error(`[${this.repo}] Error: ${err}`);
    }
  }

  private async commit(task: string): Promise<void> {
    if (!this.env.GITHUB_TOKEN) {
      return;
    }
    // TODO: Implement actual git operations
  }
}
