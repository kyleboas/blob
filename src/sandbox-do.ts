import type { Env } from "./types";

export class SandboxDO {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    // Container fetcher comes from [[containers]] name = "sandbox_v2" => env.sandbox_v2
    const container = (this.env as any).sandbox_v2 as Fetcher;

    if (!container) {
      return new Response(JSON.stringify({ error: "Container binding not found" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);
    // Cloudflare containers use http://localhost:<port> internally
    const containerUrl = `http://localhost:8080${url.pathname}${url.search}`;

    try {
      const resp = await container.fetch(containerUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });

      // For health checks, if we get a non-OK response, include details
      if (!resp.ok && url.pathname === '/health') {
        const bodyText = await resp.text().catch(() => 'No body');
        return new Response(JSON.stringify({ 
          ready: false, 
          status: resp.status,
          statusText: resp.statusText,
          body: bodyText,
          url: containerUrl
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    } catch (err) {
      return new Response(JSON.stringify({ 
        error: String(err),
        url: containerUrl,
        type: 'exception'
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}