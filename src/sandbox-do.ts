import type { Env } from "./types";

type ContainerBinding = { fetch: typeof fetch };

function resolveContainerBinding(env: Env): { container?: ContainerBinding; candidates: string[] } {
  const possibleNames = ["sandbox", "Sandbox", "SANDBOX", "BLOB_SANDBOX"] as const;

  for (const name of possibleNames) {
    const maybeContainer = (env as unknown as Record<string, unknown>)[name];
    if (maybeContainer && typeof (maybeContainer as { fetch?: unknown }).fetch === "function") {
      return { container: maybeContainer as ContainerBinding, candidates: [...possibleNames] };
    }
  }

  return { candidates: [...possibleNames] };
}

// Sandbox DO - forwards requests to the container
export class Sandbox {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const { container, candidates } = resolveContainerBinding(this.env);

    if (!container) {
      return new Response(JSON.stringify({ 
        error: "Container binding not found",
        hint: "Make sure [[containers]] is configured in wrangler.toml and that the binding is available to this Durable Object.",
        lookedFor: candidates,
        envKeys: Object.keys(this.env),
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
        error: String(err),
        url: containerUrl
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}
