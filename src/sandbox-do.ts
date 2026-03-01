import type { Env } from "./types";

export class SandboxDO {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    // Container fetcher comes from [[containers]] name = "sandbox_v2" => env.sandbox_v2
    const container = (this.env as any).sandbox_v2 as Fetcher;

    if (!container) {
      return new Response(JSON.stringify({ error: "Container not available" }), {
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

      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}