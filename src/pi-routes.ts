// pi-routes.ts - Simple HTTP routes for Pi-style agent

import type { Env } from "./types";
import { PiAgent } from "./pi-agent";

export async function handlePiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  
  if (url.pathname === "/pi/chat" && request.method === "POST") {
    const { message, repo = "default" } = await request.json() as { message: string; repo?: string };
    
    const agent = new PiAgent(env, repo);
    const response = await agent.run(message);
    
    return new Response(JSON.stringify({ response }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  if (url.pathname === "/pi/simple" && request.method === "POST") {
    // Even simpler: just bash command execution
    const { command } = await request.json() as { command: string };
    
    try {
      const result = await env.SANDBOX.exec(command);
      return new Response(JSON.stringify({ 
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  
  return new Response(JSON.stringify({ error: "Not found" }), { 
    status: 404,
    headers: { "Content-Type": "application/json" }
  });
}