import { Sandbox } from "./sandbox-do";
import type { Env } from "./types";

// Sandbox worker entry point
// This worker receives requests from the main blob-agent worker via service binding
// and executes them in the sandbox container

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Log all requests for debugging
    console.log(`[SandboxWorker] ${request.method} ${url.pathname}`);
    
    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'healthy' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Execute command
    if (url.pathname === '/execute' && request.method === 'POST') {
      try {
        const { command, timeout } = await request.json() as { command: string; timeout?: number };
        
        // For now, return a mock response
        // In a real implementation, this would execute the command in the container
        return new Response(JSON.stringify({
          stdout: `Executed: ${command}`,
          stderr: '',
          exitCode: 0
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({
          stdout: '',
          stderr: String(err),
          exitCode: 1
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // Codex login start
    if (url.pathname === '/codex/login/start' && request.method === 'POST') {
      return new Response(JSON.stringify({
        url: 'https://auth.openai.com/codex/device',
        code: 'TEST-CODE',
        instructions: '1. Open the URL\n2. Enter the code\n3. Complete login'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Codex auth save
    if (url.pathname === '/codex/auth/save' && request.method === 'POST') {
      return new Response(JSON.stringify({
        saved: true,
        message: 'Auth saved'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Codex run
    if (url.pathname === '/codex/run' && request.method === 'POST') {
      try {
        const { prompt } = await request.json() as { prompt: string };
        return new Response(JSON.stringify({
          stdout: `Codex would run: ${prompt}`,
          stderr: '',
          exitCode: 0
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({
          stdout: '',
          stderr: String(err),
          exitCode: 1
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // Return 404 with debug info
    return new Response(JSON.stringify({
      error: 'Not found',
      path: url.pathname,
      method: request.method,
      available: ['/health', '/execute', '/codex/login/start', '/codex/auth/save', '/codex/run']
    }), { 
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export { Sandbox };
