import type { Env } from "./types";

interface Memory {
  messages: Array<{ role: string; content: string; timestamp: number }>;
  userPreferences: Record<string, string>;
  context: Record<string, unknown>;
}

export class MemoryDO {
  private state: DurableObjectState;
  private memory: Memory = {
    messages: [],
    userPreferences: {},
    context: {}
  };
  private initialized = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    
    const stored = await this.state.storage.get<Memory>("memory");
    if (stored) {
      this.memory = stored;
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
      // Keep only last 100 messages
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
    
    return new Response("Not found", { status: 404 });
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { 
    status,
    headers: { "content-type": "application/json" } 
  });
}
