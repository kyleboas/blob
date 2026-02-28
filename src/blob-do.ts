import type { Env } from "./types";

interface BlobState {
  repos: string[];
  goals: Record<string, string[]>;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  userPreferences: Record<string, string>;
  modelCatalog?: Record<string, { name: string; description: string; maxTokens: number }>;
}

const DEFAULT_CATALOG: Record<string, { name: string; description: string; maxTokens: number }> = {
  "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
    name: "Llama 3.3 70B Fast",
    description: "Fast, capable model for most coding tasks. Free tier.",
    maxTokens: 4096
  },
  "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct": {
    name: "Llama 4 Scout",
    description: "More powerful, multimodal. Free tier.",
    maxTokens: 8192
  }
};

export class BlobDO {
  private state: DurableObjectState;
  private data: BlobState = {
    repos: ["kyleboas/blob"],
    goals: {},
    messages: [],
    userPreferences: {},
    modelCatalog: DEFAULT_CATALOG
  };
  private initialized = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    
    const stored = await this.state.storage.get<BlobState>("data");
    if (stored) {
      this.data = { ...this.data, ...stored };
    }
    
    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    await this.init();
    const url = new URL(request.url);
    
    // Repo endpoints
    if (url.pathname === "/repos" && request.method === "GET") {
      return json({ repos: this.data.repos });
    }
    
    if (url.pathname === "/repos" && request.method === "POST") {
      const { repo } = await request.json() as { repo: string };
      if (!this.data.repos.includes(repo)) {
        this.data.repos.push(repo);
        await this.save();
      }
      return json({ added: repo });
    }
    
    if (url.pathname === "/goals" && request.method === "GET") {
      const repo = url.searchParams.get("repo");
      if (!repo) return json({ error: "missing repo" }, 400);
      const goals = this.data.goals[repo] || ["improve codebase"];
      return json({ repo, goals });
    }
    
    if (url.pathname === "/goals" && request.method === "POST") {
      const { repo, goals } = await request.json() as { repo: string; goals: string[] };
      this.data.goals[repo] = goals;
      await this.save();
      return json({ saved: repo, goals });
    }
    
    // Memory endpoints
    if (url.pathname === "/messages" && request.method === "POST") {
      const { role, content } = await request.json() as { role: string; content: string };
      this.data.messages.push({ role, content, timestamp: Date.now() });
      if (this.data.messages.length > 100) {
        this.data.messages = this.data.messages.slice(-100);
      }
      await this.save();
      return json({ saved: true });
    }
    
    if (url.pathname === "/messages" && request.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "10");
      return json({ messages: this.data.messages.slice(-limit) });
    }
    
    if (url.pathname === "/preferences" && request.method === "POST") {
      const { key, value } = await request.json() as { key: string; value: string };
      this.data.userPreferences[key] = value;
      await this.save();
      return json({ saved: true });
    }
    
    // Catalog endpoints
    if (url.pathname === "/catalog" && request.method === "GET") {
      return json({ catalog: this.data.modelCatalog || DEFAULT_CATALOG });
    }
    
    if (url.pathname === "/catalog" && request.method === "POST") {
      const { catalog } = await request.json() as { catalog: Record<string, { name: string; description: string; maxTokens: number }> };
      this.data.modelCatalog = catalog;
      await this.save();
      return json({ saved: true, count: Object.keys(catalog).length });
    }
    
    if (url.pathname === "/catalog/update" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { 
        cfToken?: string; 
        accountId?: string;
      };
      const updated = await this.fetchModelsFromGateway(body.cfToken, body.accountId);
      if (updated) {
        this.data.modelCatalog = updated;
        await this.save();
        return json({ updated: true, count: Object.keys(updated).length });
      }
      return json({ updated: false, reason: "Could not fetch models" });
    }
    
    return new Response("Not found", { status: 404 });
  }
  
  private async save(): Promise<void> {
    await this.state.storage.put("data", this.data);
  }
  
  private async fetchModelsFromGateway(
    cfToken?: string, 
    accountId?: string
  ): Promise<Record<string, { name: string; description: string; maxTokens: number }> | null> {
    if (!cfToken || !accountId) return DEFAULT_CATALOG;

    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=100&hide_experimental=true`,
        { headers: { "Authorization": `Bearer ${cfToken}` } }
      );

      if (!response.ok) return DEFAULT_CATALOG;

      const data = await response.json() as { 
        result?: Array<{ id: string; name?: string; description?: string; task?: string }> 
      };

      if (!data.result) return DEFAULT_CATALOG;

      const catalog: Record<string, { name: string; description: string; maxTokens: number }> = {};
      for (const model of data.result) {
        if (model.task === "text-generation") {
          catalog[`workers-ai/${model.id}`] = {
            name: model.name || model.id,
            description: model.description || "Workers AI model",
            maxTokens: 4096
          };
        }
      }

      return Object.keys(catalog).length > 0 ? catalog : DEFAULT_CATALOG;
    } catch {
      return DEFAULT_CATALOG;
    }
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { 
    status,
    headers: { "content-type": "application/json" } 
  });
}
