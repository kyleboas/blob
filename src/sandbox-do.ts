import type { Env } from "./types";

type ContainerBinding = { fetch: typeof fetch };

function resolveContainerBinding(
  state: DurableObjectState,
  env: Env
): { container?: ContainerBinding; candidates: string[] } {
  const possibleNames = ["sandbox", "Sandbox", "SANDBOX", "BLOB_SANDBOX"] as const;

  const stateContainer = (state as DurableObjectState & { container?: ContainerBinding }).container;
  if (stateContainer && typeof stateContainer.fetch === "function") {
    return { container: stateContainer, candidates: ["state.container", ...possibleNames] };
  }

  for (const name of possibleNames) {
    const maybeContainer = (env as unknown as Record<string, unknown>)[name];
    if (maybeContainer && typeof (maybeContainer as { fetch?: unknown }).fetch === "function") {
      return { container: maybeContainer as ContainerBinding, candidates: ["state.container", ...possibleNames] };
    }
  }

  return { candidates: ["state.container", ...possibleNames] };
}

// Sandbox DO - forwards requests to the container
export class Sandbox {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const { container, candidates } = resolveContainerBinding(this.state, this.env);
    const url = new URL(request.url);

    if (!container) {
      return this.handleFallbackRequest(request, url, candidates);
    }

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
        headers: resp.headers,
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: String(err),
        url: containerUrl,
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleFallbackRequest(
    request: Request,
    url: URL,
    candidates: string[]
  ): Promise<Response> {
    const fallbackDetails = {
      mode: "fallback",
      reason: "Container binding not found",
      hint: "Single-worker setup: keep everything in blob-agent, ensure [[containers]] name=\"sandbox\" class_name=\"Sandbox\" is deployed, then redeploy blob-agent.",
      lookedFor: candidates,
      envKeys: Object.keys(this.env),
    };

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "degraded",
        ...fallbackDetails,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/execute" && request.method === "POST") {
      const payload = await request.json() as { command?: string };
      return new Response(JSON.stringify({
        stdout: payload.command ? `Simulated execution (no sandbox container): ${payload.command}` : "",
        stderr: "",
        exitCode: 0,
        ...fallbackDetails,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/codex/login/start" && request.method === "POST") {
      return new Response(JSON.stringify({
        url: "https://platform.openai.com/login",
        instructions: "Sandbox container is unavailable, so device-code login cannot be started.",
        ...fallbackDetails,
      }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/codex/auth/save" && request.method === "POST") {
      return new Response(JSON.stringify({
        saved: false,
        message: "Sandbox container unavailable; no auth file was written.",
        ...fallbackDetails,
      }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/codex/run" && request.method === "POST") {
      return new Response(JSON.stringify({
        stdout: "",
        stderr: "Sandbox container unavailable; cannot run Codex CLI.",
        exitCode: 1,
        ...fallbackDetails,
      }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      error: "Not found",
      path: url.pathname,
      method: request.method,
      available: ["/health", "/execute", "/codex/login/start", "/codex/auth/save", "/codex/run"],
      ...fallbackDetails,
    }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
}
