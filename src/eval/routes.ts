import type { Env } from "../core/types";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authorize(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  const token = env.EVAL_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  if (!token) return false;
  return auth === `Bearer ${token}`;
}

export async function handleEvalRequest(
  request: Request,
  pathname: string,
  env: Env,
): Promise<Response> {
  if (!authorize(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (pathname === "/eval/setup" && request.method === "POST") {
    return handleEvalSetup(request, env);
  }

  if (pathname === "/eval/message" && request.method === "POST") {
    return handleEvalMessage(request, env);
  }

  if (pathname === "/eval/state" && request.method === "GET") {
    return handleEvalState(env);
  }

  return json({ error: "Unknown eval endpoint" }, 404);
}

async function handleEvalSetup(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    action: string;
    path?: string;
    content?: string;
    command?: string;
  };

  if (body.action === "write_file" && body.path && body.content !== undefined) {
    await env.SANDBOX.writeFile(body.path, body.content);
    return json({ ok: true });
  }

  if (body.action === "run_command" && body.command) {
    const result = await env.SANDBOX.exec(body.command);
    return json({ ok: true, output: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
  }

  return json({ error: "Unknown action" }, 400);
}

async function handleEvalMessage(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    channel: string;
    user: string;
    text: string;
  };

  // Route through the Durable Object to exercise the full agent path
  const doId = env.AGENT_DO.idFromName(`eval-${body.channel}`);
  const stub = env.AGENT_DO.get(doId);

  const doRequest = new Request("https://internal/eval/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: body.channel,
      user: body.user,
      text: body.text,
      eval_mode: true,
    }),
  });

  const doResponse = await stub.fetch(doRequest);
  const result = await doResponse.json();
  return json(result);
}

async function handleEvalState(env: Env): Promise<Response> {
  // Return basic sandbox state for eval verification
  try {
    const homeContents = await env.SANDBOX.exec("find /home/user -type f 2>/dev/null | head -50");
    return json({
      files: homeContents.stdout.split("\n").filter(Boolean),
      timestamp: new Date().toISOString(),
    });
  } catch {
    return json({ files: [], timestamp: new Date().toISOString() });
  }
}
