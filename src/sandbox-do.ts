import type { Env } from "./types";

// Sandbox DO - kept for backward compatibility with existing Durable Objects
export class Sandbox {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    // Forward to the service binding instead
    if (!this.env.SANDBOX) {
      return new Response("Sandbox service not available", { status: 503 });
    }
    return this.env.SANDBOX.fetch(request);
  }
}