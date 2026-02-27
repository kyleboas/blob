import { mapChannelToDO, parseSlackEvent, verifySlackSignature } from "./slack";
import { classifyMessage } from "./llm";
import type { Env, SlackEvent } from "./types";

export { AgentDO } from "./agent";

const GLOBAL_LOGS_CHANNEL = "__global__";
const HEARTBEAT_DO_NAME = "blob:heartbeats";
const LOG_FETCH_TIMEOUT_MS = 8000;

// Global WebSocket connections storage (persists across requests in the same isolate)
const globalWsConnections = new Map<string, WebSocket>();

interface DiagCheckResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

async function runDiagCheck(name: string, fn: () => Promise<void>): Promise<DiagCheckResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, ok: true, ms: Date.now() - start };
  } catch (error) {
    return {
      name,
      ok: false,
      ms: Date.now() - start,
      error: error instanceof Error ? error.message : "unknown error"
    };
  }
}

async function runDiagnostics(env: Env, traceId: string): Promise<{ trace_id: string; ok: boolean; checks: DiagCheckResult[] }> {
  const checks: DiagCheckResult[] = [];

  checks.push(await runDiagCheck("worker_health", async () => {
    if (!env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN missing");
  }));

  checks.push(await runDiagCheck("do_round_trip", async () => {
    const response = await forwardToHeartbeatDO(env, { action: "logs_snapshot", trace_id: traceId });
    if (!response.ok) throw new Error(`DO returned ${response.status}`);
  }));

  checks.push(await runDiagCheck("sandbox_exec", async () => {
    if (!env.SANDBOX) throw new Error("SANDBOX binding missing");
    const sandbox = env.SANDBOX as unknown as { exec: (command: string) => Promise<{ stdout?: string; stderr?: string; exitCode?: number }> };
    const result = await sandbox.exec("echo ok");
    if ((result.exitCode ?? 1) !== 0) throw new Error(result.stderr ?? "sandbox command failed");
  }));

  checks.push(await runDiagCheck("llm_config", async () => {
    const classification = await classifyMessage({
      systemPrompt: "diag",
      messages: [{ role: "user", content: "ping" }],
      routerModel: "openai/gpt-4.1-mini",
      apiKey: env.ANTHROPIC_API_KEY,
      openAiApiKey: env.OPENAI_API_KEY,
      aiGatewayBaseUrl: env.AI_GATEWAY_BASE_URL,
      aiGatewayToken: env.AI_GATEWAY_TOKEN
    });
    if (!["chat", "routine", "complex"].includes(classification)) {
      throw new Error("Unexpected LLM classification result");
    }
  }));

  checks.push(await runDiagCheck("github_auth", async () => {
    const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN missing");
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json"
      }
    });
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  }));

  return {
    trace_id: traceId,
    ok: checks.every((check) => check.ok),
    checks
  };
}

async function forwardToHeartbeatDO(
  env: Env,
  payload: Record<string, unknown>
): Promise<Response> {
  const id = env.AGENT_DO.idFromName(HEARTBEAT_DO_NAME);
  const stub = env.AGENT_DO.get(id);
  return stub.fetch("https://agent.internal/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function forwardToAgent(env: Env, channel: string, payload: { action: "message" | "reaction" | "logs_mirror"; event: SlackEvent }): Promise<void> {
  const id = env.AGENT_DO.idFromName(mapChannelToDO(channel));
  const stub = env.AGENT_DO.get(id);

  const response = await stub.fetch("https://agent.internal/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Agent Durable Object request failed with status ${response.status}`);
  }
}

function renderLiveLogPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Blob Live Logs</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      background: #ffffff;
      color: #000000;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 20px;
    }
    #status {
      margin-bottom: 12px;
      font-size: 13px;
    }
    #log {
      margin: 0;
      white-space: pre-wrap;
      min-height: 280px;
      max-height: calc(100vh - 120px);
      overflow-y: auto;
    }
    .empty {
      color: #000000;
      font-style: italic;
    }
    .line {
      color: #000000;
    }
  </style>
</head>
<body>
  <h1>Blob Live Logs</h1>
  <div id="status">Live across all channels.</div>
  <div id="log"><span class="empty">Waiting for events...</span></div>
  <script>
    const logNode = document.getElementById('log');
    const statusNode = document.getElementById('status');
    let currentEvents = [];
    let stream = null;
    let reconnectTimer = null;

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function formatLine(event) {
      const when = new Date(event.createdAt * 1000).toISOString().replace('T', ' ').replace('Z', '');
      const text = when + '  [' + event.eventType + ']  ' + event.message;
      return '<span class="line">' + escHtml(text) + '</span>';
    }

    function renderLogs(events) {
      if (!events.length) {
        logNode.innerHTML = '<span class="empty">No events yet.</span>';
        return;
      }

      const atBottom = logNode.scrollHeight - logNode.scrollTop <= logNode.clientHeight + 50;
      const lines = events.slice().reverse().map(formatLine).join('\n');
      logNode.innerHTML = lines;
      if (atBottom) logNode.scrollTop = logNode.scrollHeight;
    }

    async function loadSnapshot() {
      try {
        const response = await fetch('/logs/data', { cache: 'no-store' });
        if (!response.ok) throw new Error('snapshot request failed');
        const data = await response.json();
        currentEvents = Array.isArray(data.events) ? data.events : [];
        renderLogs(currentEvents);
        statusNode.textContent = 'Live across all channels.';
      } catch {
        statusNode.textContent = 'Failed to load logs snapshot.';
      }
    }

    function connectStream() {
      // TEMPORARY: Use polling instead of SSE to avoid hanging issues
      statusNode.textContent = 'Polling logs...';
      
      const poll = async () => {
        try {
          const response = await fetch('/logs/stream');
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          currentEvents = Array.isArray(data.events) ? data.events : [];
          renderLogs(currentEvents);
          statusNode.textContent = 'Live across all channels • ' + currentEvents.length + ' events';
        } catch (err) {
          statusNode.textContent = 'Poll failed: ' + (err instanceof Error ? err.message : String(err));
        }
      };
      
      // Poll immediately and then every 5 seconds
      poll();
      return setInterval(poll, 5000);
    }

    renderLogs(currentEvents);
    loadSnapshot();
    setInterval(loadSnapshot, 5000);
    const pollInterval = connectStream();
  </script>
</body>
</html>`;
}

async function fetchGlobalLogsSnapshot(env: Env): Promise<Response> {
  const id = env.AGENT_DO.idFromName(mapChannelToDO(GLOBAL_LOGS_CHANNEL));
  const stub = env.AGENT_DO.get(id);
  console.log("[LOGS] Fetching from DO:", mapChannelToDO(GLOBAL_LOGS_CHANNEL));
  const response = await Promise.race([
    stub.fetch("https://agent.internal/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "logs_snapshot" })
    }),
    new Promise<Response>((_, reject) => {
      setTimeout(() => reject(new Error("logs snapshot timed out")), LOG_FETCH_TIMEOUT_MS);
    })
  ]);

  if (!response.ok) {
    const text = await response.text();
    console.error("[LOGS] DO returned error:", response.status, text);
    throw new Error("failed to read logs");
  }

  return response;
}

// WebSocket handler for real-time logs
async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return new Response("Expected websocket", { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WebSocketPairConstructor = (globalThis as any).WebSocketPair;
  const webSocketPair = new WebSocketPairConstructor();
  const client = webSocketPair[0] as WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = webSocketPair[1] as any;

  server.accept();

  // Send initial snapshot
  try {
    const response = await fetchGlobalLogsSnapshot(env);
    const payload = await response.json();
    server.send(JSON.stringify({ type: "snapshot", data: payload }));
  } catch (error) {
    console.error("[LOGS] WebSocket initial snapshot failed:", error);
    server.send(JSON.stringify({ type: "error", message: "Failed to fetch logs - will retry" }));
    // Send empty events array so client shows something
    server.send(JSON.stringify({ type: "snapshot", data: { events: [] } }));
  }

  // Set up periodic updates (every 5 seconds instead of 1)
  const intervalId = setInterval(async () => {
    try {
      const response = await fetchGlobalLogsSnapshot(env);
      const payload = await response.json();
      server.send(JSON.stringify({ type: "snapshot", data: payload }));
    } catch (error) {
      // Log error but don't crash - client will reconnect if needed
      console.error("[LOGS] Periodic update failed:", error);
    }
  }, 5000);

  // Clean up on close
  server.addEventListener("close", () => {
    clearInterval(intervalId);
  });

  server.addEventListener("error", () => {
    clearInterval(intervalId);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Response(null, {
    status: 101,
    webSocket: client,
  } as any);
}

// SSE handler for fallback
function handleSSE(env: Env): Response {
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(": connected\n\n"));

      // Send initial empty snapshot immediately so page shows something
      controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify({ events: [] })}\n\n`));

      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 3;

      while (!closed && consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
        try {
          // Fetch with shorter timeout for SSE (5s instead of 8s)
          const response = await Promise.race([
            fetchGlobalLogsSnapshot(env),
            new Promise<Response>((_, reject) => 
              setTimeout(() => reject(new Error("SSE fetch timeout")), 5000)
            )
          ]);
          const payload = await response.text();
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${payload}\n\n`));
          consecutiveErrors = 0; // Reset on success
        } catch (error) {
          consecutiveErrors++;
          console.error(`[SSE] Fetch error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, error);
          controller.enqueue(encoder.encode(`event: error\ndata: {"error":"failed to read logs - retrying"}\n\n`));
          
          // Send empty events to keep client alive
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify({ events: [] })}\n\n`));
          
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.error("[SSE] Too many errors, closing stream");
            controller.enqueue(encoder.encode(`event: error\ndata: {"error":"max retries exceeded"}\n\n`));
            closed = true;
          }
        }

        // Wait before next fetch (5 seconds)
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      
      controller.close();
    },
    cancel() {
      closed = true;
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}

// Blob WebSocket chat handler
async function handleBlobWebSocket(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return new Response("Expected websocket", { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WebSocketPairConstructor = (globalThis as any).WebSocketPair;
  const webSocketPair = new WebSocketPairConstructor();
  const client = webSocketPair[0] as WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = webSocketPair[1] as any;

  server.accept();

  // Generate a unique channel for this WebSocket connection
  const channel = `ws-${crypto.randomUUID()}`;
  
  // Store WebSocket connection in global map
  globalWsConnections.set(channel, server as unknown as WebSocket);

  // Send welcome message
  server.send(JSON.stringify({
    type: "connected",
    channel,
    message: "Connected to Blob. Send a message to start chatting."
  }));

  // Handle incoming messages from client
  server.addEventListener("message", async (event: { data: string }) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === "message" && data.text) {
        // Forward to AgentDO
        const doName = `slack-channel:${channel}`;
        
        try {
          const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(doName));
          
          // Send message to AgentDO with timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
          
          const response = await stub.fetch("https://agent.internal/event", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "message",
              event: {
                type: "message",
                channel,
                text: data.text,
                user: data.user || "web-user",
                ts: Date.now().toString()
              },
              wsChannel: channel
            }),
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);

          if (!response.ok) {
            const errorText = await response.text().catch(() => "Unknown error");
            throw new Error(`AgentDO returned ${response.status}: ${errorText}`);
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          
          // Self-healing: Check if DO exists, if not create it
          if (errorMessage.includes("not found") || errorMessage.includes("failed")) {
            server.send(JSON.stringify({
              type: "status",
              message: "Initializing Blob, one moment..."
            }));
            
            // Retry after a short delay
            setTimeout(async () => {
              try {
                const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(doName));
                await stub.fetch("https://agent.internal/event", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    action: "message",
                    event: {
                      type: "message",
                      channel,
                      text: data.text,
                      user: data.user || "web-user",
                      ts: Date.now().toString()
                    },
                    wsChannel: channel
                  })
                });
              } catch (retryErr) {
                server.send(JSON.stringify({
                  type: "error",
                  message: "Blob is having trouble. Please try again in a moment."
                }));
              }
            }, 2000);
          } else {
            server.send(JSON.stringify({
              type: "error",
              message: `Error: ${errorMessage}`
            }));
          }
        }
      } else if (data.type === "ping") {
        server.send(JSON.stringify({ type: "pong" }));
      }
    } catch (err) {
      server.send(JSON.stringify({
        type: "error",
        message: err instanceof Error ? err.message : "Invalid message format"
      }));
    }
  });

  // Handle close
  server.addEventListener("close", () => {
    globalWsConnections.delete(channel);
  });

  server.addEventListener("error", (err: unknown) => {
    console.error("WebSocket error:", err);
    globalWsConnections.delete(channel);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Response(null, {
    status: 101,
    webSocket: client,
  } as any);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/diag/run") {
      const authHeader = request.headers.get("authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      if (!env.DIAG_TOKEN || !token || token !== env.DIAG_TOKEN) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      const traceId = crypto.randomUUID();
      const payload = await runDiagnostics(env, traceId);
      return Response.json(payload, { status: payload.ok ? 200 : 500 });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/logs" || url.pathname === "/live-logs")) {
      return new Response(renderLiveLogPage(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    // Debug endpoint to inject a test log event
    if (request.method === "POST" && url.pathname === "/logs/test") {
      try {
        const id = env.AGENT_DO.idFromName(mapChannelToDO(GLOBAL_LOGS_CHANNEL));
        const stub = env.AGENT_DO.get(id);
        await stub.fetch("https://agent.internal/event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "log_event", eventType: "test", message: "Test log event at " + new Date().toISOString() })
        });
        return Response.json({ success: true, message: "Test event injected" });
      } catch (error) {
        return Response.json({ success: false, error: String(error) }, { status: 500 });
      }
    }

    if (request.method === "GET" && (url.pathname === "/logs/data" || url.pathname === "/live-logs/data")) {
      let response: Response;
      try {
        response = await fetchGlobalLogsSnapshot(env);
      } catch (error) {
        console.error("[LOGS] Failed to fetch snapshot:", error);
        return Response.json({ events: [], error: "failed to read logs" }, { status: 200 });
      }

      const payload = await response.text();
      return new Response(payload, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-cache" } });
    }

    if (request.method === "GET" && (url.pathname === "/logs/stream" || url.pathname === "/live-logs/stream")) {
      // TEMPORARY: Return JSON instead of SSE to avoid hanging issues
      // The SSE handler is having issues with DO timeouts
      try {
        const response = await fetchGlobalLogsSnapshot(env);
        const payload = await response.json();
        return Response.json(payload, { 
          status: 200, 
          headers: { 
            "content-type": "application/json",
            "cache-control": "no-cache"
          } 
        });
      } catch (error) {
        console.error("[LOGS] Stream fallback failed:", error);
        return Response.json({ events: [] }, { status: 200 });
      }
    }

    // Blob WebSocket response endpoint (for AgentDO to send responses back)
    if (request.method === "POST" && url.pathname === "/chat/response") {
      const body = await request.json() as { channel?: string; text?: string; type?: string };
      const channel = body.channel;
      const text = body.text;
      
      if (!channel || !text) {
        return Response.json({ error: "channel and text required" }, { status: 400 });
      }
      
      const ws = globalWsConnections.get(channel);
      if (ws && ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify({ type: body.type || "message", text }));
        return new Response("ok");
      }
      
      return Response.json({ error: "WebSocket not found or closed" }, { status: 404 });
    }

    // Blob WebSocket chat endpoint
    if (request.method === "GET" && url.pathname === "/chat") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader === "websocket") {
        return handleBlobWebSocket(request, env);
      }
      return new Response("Expected WebSocket", { status: 400 });
    }

    // Heartbeat API – enqueue background tasks for Blob to work on proactively
    if (request.method === "POST" && url.pathname === "/heartbeats") {
      const body = await request.json() as { task?: string; channel?: string };
      if (!body.task || !body.channel) {
        return Response.json({ error: "task and channel are required" }, { status: 400 });
      }
      const response = await forwardToHeartbeatDO(env, {
        action: "enqueue_heartbeat",
        task: body.task,
        channel: body.channel
      });
      return response;
    }

    if (request.method === "GET" && url.pathname === "/heartbeats") {
      const response = await forwardToHeartbeatDO(env, { action: "list_heartbeats" });
      return response;
    }

    // Deploy hook - trigger heartbeats on all active channels after deployment
    if (request.method === "POST" && url.pathname === "/deploy") {
      const authHeader = request.headers.get("authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      if (!env.DIAG_TOKEN || !token || token !== env.DIAG_TOKEN) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      // Trigger heartbeat alarm on the global heartbeat DO
      const response = await forwardToHeartbeatDO(env, { 
        action: "deploy_trigger",
        timestamp: new Date().toISOString()
      });
      
      return Response.json({ 
        status: "triggered", 
        message: "Heartbeat alarms scheduled on all active channels"
      }, { status: 200 });
    }

    if (request.method !== "POST" || url.pathname !== "/slack/events") {
      return new Response("not found", { status: 404 });
    }

    const verified = await verifySlackSignature(request, env.SLACK_SIGNING_SECRET);
    if (!verified) {
      return new Response("invalid signature", { status: 401 });
    }

    const body = await request.text();
    let envelope;
    try {
      envelope = parseSlackEvent(body);
    } catch {
      return new Response("bad request", { status: 400 });
    }

    if (envelope.type === "url_verification") {
      return Response.json({ challenge: envelope.challenge ?? "" });
    }

    const event = envelope.event;
    if (!event) {
      return new Response("ok", { status: 200 });
    }

    if (event.type === "message") {
      // Skip bot messages (including own responses) and message subtypes
      // (edited/deleted messages) to prevent infinite loops and noise
      if (!event.subtype && !event.bot_id) {
        const channel = event.channel;
        if (channel) {
          ctx.waitUntil(forwardToAgent(env, channel, { action: "message", event }));
          ctx.waitUntil(forwardToAgent(env, GLOBAL_LOGS_CHANNEL, { action: "logs_mirror", event }));
        }
      }
      return new Response("ok", { status: 200 });
    }

    if (event.type === "reaction_added") {
      const channel = event.item?.channel ?? event.channel;
      if (channel) {
        ctx.waitUntil(forwardToAgent(env, channel, { action: "reaction", event }));
        ctx.waitUntil(forwardToAgent(env, GLOBAL_LOGS_CHANNEL, { action: "logs_mirror", event }));
      }
      return new Response("ok", { status: 200 });
    }

    return new Response("ok", { status: 200 });
  }
};
