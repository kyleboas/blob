import type { Env } from "./types";

// Cloudflare Sandbox DO - runs commands in the container
export class Sandbox {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Get container from state (injected by Cloudflare runtime for container-backed DOs)
    const container = (this.state as any).container as { fetch: typeof fetch } | undefined;

    if (!container) {
      // Fallback: handle requests directly if no container (for testing)
      return this.handleDirectRequest(request, url);
    }

    // Forward to container's HTTP server
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
  
  // Direct request handler (when container is not available)
  private async handleDirectRequest(request: Request, url: URL): Promise<Response> {
    const headers = { "Content-Type": "application/json" };
    
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'healthy (no container)' }), { headers });
    }
    
    if (url.pathname === '/execute' && request.method === 'POST') {
      const { command } = await request.json() as { command: string };
      return new Response(JSON.stringify({
        stdout: `Would execute: ${command}`,
        stderr: 'Container not available - running in fallback mode',
        exitCode: 0
      }), { headers });
    }
    
    if (url.pathname === '/codex/login/start' && request.method === 'POST') {
      return new Response(JSON.stringify({
        url: 'https://auth.openai.com/codex/device',
        code: 'TEST-CODE',
        instructions: '1. Open URL\n2. Enter code\n3. Complete login'
      }), { headers });
    }
    
    if (url.pathname === '/codex/status' && request.method === 'GET') {
      return new Response(JSON.stringify({
        authenticated: false,
        message: 'Container not available - cannot check auth'
      }), { headers });
    }
    
    if (url.pathname === '/codex/auth/save' && request.method === 'POST') {
      return new Response(JSON.stringify({ saved: true, message: 'Auth saved (fallback)' }), { headers });
    }
    
    if (url.pathname === '/codex/run' && request.method === 'POST') {
      const { prompt } = await request.json() as { prompt: string };
      return new Response(JSON.stringify({
        stdout: `Would run: ${prompt}`,
        stderr: 'Container not available',
        exitCode: 0
      }), { headers });
    }
    
    return new Response(JSON.stringify({ error: 'Not found', path: url.pathname }), { 
      status: 404, headers 
    });
  }
}