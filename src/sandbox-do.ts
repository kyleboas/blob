import type { Env } from "./types";

// Note: Class must be named "Sandbox" to match wrangler.toml class_name
export class Sandbox {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    // Try multiple ways to access the container
    // 1. state.container - for container-backed DOs
    // 2. env.sandbox_v2 - for explicit container bindings
    const container = (this.state as any).container ?? (this.env as any).sandbox_v2;

    if (!container) {
      return new Response(JSON.stringify({ 
        error: "Container not available",
        debug: {
          stateKeys: Object.keys(this.state),
          envKeys: Object.keys(this.env).filter(k => !k.startsWith('_')),
          hasStateContainer: 'container' in this.state,
          hasEnvSandbox: 'sandbox_v2' in this.env
        }
      }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Check if container has fetch method
    if (typeof container.fetch !== 'function') {
      return new Response(JSON.stringify({ 
        error: "Container exists but fetch is not a function",
        debug: {
          containerType: typeof container,
          containerKeys: Object.keys(container),
          hasFetch: typeof container.fetch === 'function'
        }
      }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);
    const containerUrl = `http://localhost:8080${url.pathname}${url.search}`;

    try {
      const resp = await container.fetch(containerUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });

      if (!resp.ok && url.pathname === '/health') {
        const bodyText = await resp.text().catch(() => 'No body');
        return new Response(JSON.stringify({ 
          ready: false, 
          status: resp.status,
          body: bodyText
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    } catch (err) {
      return new Response(JSON.stringify({ 
        error: String(err),
        type: 'exception'
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}