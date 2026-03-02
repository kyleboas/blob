// Sandbox worker entry point
// This worker runs in the container and handles requests from the main worker

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    // Get container from env (this worker has the container binding)
    const container = env.sandbox as { fetch: typeof fetch } | undefined;
    
    if (!container) {
      return new Response(JSON.stringify({ 
        error: "Container not available in sandbox worker",
        hint: "Make sure [[containers]] is configured in wrangler.sandbox.toml"
      }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Forward to container's HTTP server
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
        url: containerUrl
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
};