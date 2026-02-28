import type { Env } from "./types";

export class AgentDO {
  private state: DurableObjectState;
  private repos: string[] = ["kyleboas/blob"];
  private goals: Map<string, string[]> = new Map();
  private initialized = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    
    const storedRepos = await this.state.storage.get<string[]>("repos");
    if (storedRepos) {
      this.repos = storedRepos;
    }
    
    const keys = await this.state.storage.list({ prefix: "goals:" });
    for (const [key, value] of keys) {
      const repo = key.replace("goals:", "");
      this.goals.set(repo, value as string[]);
    }
    
    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    await this.init();
    
    const url = new URL(request.url);
    
    if (url.pathname === "/repos" && request.method === "GET") {
      return json({ repos: this.repos });
    }
    
    if (url.pathname === "/repos" && request.method === "POST") {
      const { repo } = await request.json() as { repo: string };
      if (!this.repos.includes(repo)) {
        this.repos.push(repo);
        await this.state.storage.put("repos", this.repos);
      }
      return json({ added: repo });
    }
    
    if (url.pathname === "/goals" && request.method === "GET") {
      const repo = url.searchParams.get("repo");
      if (!repo) return json({ error: "missing repo" }, 400);
      const goals = this.goals.get(repo) || ["improve codebase"];
      return json({ repo, goals });
    }
    
    if (url.pathname === "/goals" && request.method === "POST") {
      const { repo, goals } = await request.json() as { repo: string; goals: string[] };
      this.goals.set(repo, goals);
      await this.state.storage.put(`goals:${repo}`, goals);
      return json({ saved: repo, goals });
    }
    
    return new Response("Not found", { status: 404 });
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { 
    status,
    headers: { "content-type": "application/json" } 
  });
}
