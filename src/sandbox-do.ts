import type { Env } from "./types";

export class Sandbox {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    // Get the container fetcher from the environment
    const container = (this.env as any).SANDBOX as Fetcher;
    
    if (!container) {
      return new Response(JSON.stringify({ error: "Container not available" }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Forward the request to the container
    const url = new URL(request.url);
    const containerUrl = `http://localhost:8080${url.pathname}`;
    
    try {
      const response = await container.fetch(containerUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body
      });
      
      return new Response(response.body, {
        status: response.status,
        headers: response.headers
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
}