import type { Env } from "./types";

// Sandbox DO for backward compatibility with existing Durable Objects
// This class is kept to avoid breaking existing DO instances
export class Sandbox {
  async fetch(request: Request): Promise<Response> {
    return new Response("Sandbox DO deprecated. Use service binding instead.", { status: 410 });
  }
}