import type { Env } from "./types";

interface Memory {
  messages: Array<{ role: string; content: string; timestamp: number }>;
  userPreferences: Record<string, string>;
  context: Record<string, unknown>;
  modelCatalog?: Record<string, { name: string; description: string; maxTokens: number }>;
  lastCatalogUpdate?: number;
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
  },
  "anthropic/claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    description: "Excellent for complex reasoning. Paid.",
    maxTokens: 8192
  }
};

export class MemoryDO {
  private state: DurableObjectState;
  private memory: Memory = {
    messages: [],
    userPreferences: {},
    context: {},
    modelCatalog: DEFAULT_CATALOG
  };
  private initialized = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    
    const stored = await this.state.storage.get<Memory>("memory");
    if (stored) {
      this.memory = { ...this.memory, ...stored };
    }
    
    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    await this.init();
    const url = new URL(request.url);
    
    if (url.pathname === "/memory" && request.method === "GET") {
      return json(this.memory);
    }
    
    if (url.pathname === "/memory" && request.method === "POST") {
      const update = await request.json() as Partial<Memory>;
      this.memory = { ...this.memory, ...update };
      await this.state.storage.put("memory", this.memory);
      return json({ saved: true });
    }
    
    if (url.pathname === "/messages" && request.method === "POST") {
      const { role, content } = await request.json() as { role: string; content: string };
      this.memory.messages.push({ role, content, timestamp: Date.now() });
      if (this.memory.messages.length > 100) {
        this.memory.messages = this.memory.messages.slice(-100);
      }
      await this.state.storage.put("memory", this.memory);
      return json({ saved: true });
    }
    
    if (url.pathname === "/messages" && request.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "10");
      return json({ messages: this.memory.messages.slice(-limit) });
    }
    
    if (url.pathname === "/preferences" && request.method === "POST") {
      const { key, value } = await request.json() as { key: string; value: string };
      this.memory.userPreferences[key] = value;
      await this.state.storage.put("memory", this.memory);
      return json({ saved: true });
    }
    
    if (url.pathname === "/catalog" && request.method === "GET") {
      return json({ catalog: this.memory.modelCatalog || DEFAULT_CATALOG });
    }
    
    if (url.pathname === "/catalog" && request.method === "POST") {
      const { catalog } = await request.json() as { catalog: Record<string, { name: string; description: string; maxTokens: number }> };
      this.memory.modelCatalog = catalog;
      await this.state.storage.put("memory", this.memory);
      return json({ saved: true, count: Object.keys(catalog).length });
    }
    
    if (url.pathname === "/catalog/update" && request.method === "POST") {
      // Only update if it's been 7 days since last update
      const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
      const lastUpdate = this.memory.lastCatalogUpdate || 0;
      
      if (Date.now() - lastUpdate < ONE_WEEK) {
        return json({ 
          updated: false, 
          reason: "Catalog updated recently", 
          nextUpdate: new Date(lastUpdate + ONE_WEEK).toISOString()
        });
      }
      
      const body = await request.json().catch(() => ({})) as { 
        cfToken?: string; 
        accountId?: string;
      };
      const updated = await this.fetchModelsFromGateway(body.cfToken, body.accountId);
      if (updated) {
        this.memory.modelCatalog = updated;
        this.memory.lastCatalogUpdate = Date.now();
        await this.state.storage.put("memory", this.memory);
        return json({ updated: true, count: Object.keys(updated).length });
      }
      return json({ updated: false, reason: "Could not fetch models" });
    }
    
    return new Response("Not found", { status: 404 });
  }
  
  private async fetchModelsFromGateway(
    cfToken?: string, 
    accountId?: string
  ): Promise<Record<string, { name: string; description: string; maxTokens: number }> | null> {
    if (!cfToken || !accountId) {
      return DEFAULT_CATALOG;
    }

    try {
      // Fetch Workers AI models
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=100&hide_experimental=true`,
        {
          headers: {
            "Authorization": `Bearer ${cfToken}`,
          },
        }
      );

      if (!response.ok) {
        return DEFAULT_CATALOG;
      }

      const data = await response.json() as { 
        result?: Array<{ 
          id: string; 
          name?: string; 
          description?: string;
          task?: string;
        }> 
      };

      if (!data.result) {
        return DEFAULT_CATALOG;
      }

      // Convert to catalog format
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
