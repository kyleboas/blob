import type { Env } from "./types";

interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class Sandbox {
  private container: Fetcher;

  constructor(state: DurableObjectState, env: Env) {
    // The container binding from wrangler.toml
    this.container = (env as any).sandbox as Fetcher;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      try {
        const r = await this.container.fetch("http://localhost:8080/health");
        return new Response(JSON.stringify({ ready: r.ok }), { 
          status: r.ok ? 200 : 503,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ ready: false, error: String(err) }), { 
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname === '/execute' && request.method === 'POST') {
      try {
        const data = await request.json() as { command: string; timeout?: number };
        const r = await this.container.fetch("http://localhost:8080/execute", {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }

    if (url.pathname === '/codex/login/start' && request.method === 'POST') {
      try {
        const r = await this.container.fetch("http://localhost:8080/codex/login/start", { method: 'POST' });
        return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }

    if (url.pathname === '/codex/auth/save' && request.method === 'POST') {
      try {
        const r = await this.container.fetch("http://localhost:8080/codex/auth/save", { method: 'POST' });
        return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }

    if (url.pathname === '/codex/run' && request.method === 'POST') {
      try {
        const r = await this.container.fetch("http://localhost:8080/codex/run", {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: request.body
        });
        return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = (env as any).Sandbox.idFromName("default");
    const stub = (env as any).Sandbox.get(id);
    return stub.fetch(request);
  }
};