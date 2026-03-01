import type { Env } from "./types";

// Sandbox DO - forwards requests to the container
export class Sandbox {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const container = (this.state as any).container as { fetch: typeof fetch } | undefined;

    if (!container) {
      return new Response(JSON.stringify({ 
        error: "Container not available"
      }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);
    const containerUrl = `http://localhost:8080${url.pathname}${url.search}`;

    // Clean up headers before forwarding
    const headers = new Headers(request.headers);
    headers.delete("host");

    try {
      const resp = await container.fetch(containerUrl, {
        method: request.method,
        headers,
        body: request.body,
      });

      return new Response(resp.body, { 
        status: resp.status, 
        headers: resp.headers 
      });
    } catch (err) {
      return new Response(JSON.stringify({ 
        error: String(err)
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}