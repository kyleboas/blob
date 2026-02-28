import type { Env } from "./types";
import { plan } from "./llm";

export class Agent {
  constructor(private repo: string, private goals: string[], private env: Env) {}

  async run(): Promise<void> {
    try {
      const task = await plan(this.goals, this.env);
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
