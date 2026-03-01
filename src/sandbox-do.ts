import type { Env } from "./types";

// Sandbox DO - forwards requests to the container via state.container
export class Sandbox {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    // Get container from state (injected by Cloudflare runtime for container-backed DOs)
    const container = (this.state as any).container as { fetch: typeof fetch } | undefined;

    if (!container) {
      return new Response(JSON.stringify({ 
        error: "Container not available",
        hint: "Make sure [[containers]] binding is configured in wrangler.toml with class_name = 'Sandbox'"
      }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Forward to container's HTTP server on localhost:8080
    // The container runs server.py which handles /execute, /codex/*, etc.
    const url = new URL(request.url);
    const containerUrl = `http://localhost:8080${url.pathname}${url.search}`;

    try {
      const resp = await container.fetch(containerUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });

      return new Response(resp.body, { 
        status: resp.status, 
        headers: resp.headers 
      });
    } catch (err) {
      return new Response(JSON.stringify({ 
        error: String(err),
        url: containerUrl,
        type: 'container_fetch_error'
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}