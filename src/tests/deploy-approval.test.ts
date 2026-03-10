import test from "node:test";
import assert from "node:assert/strict";
import { checkApproval, processApprovalMessage, requestApproval } from "../agent/deploy-approval";
import type { Env } from "../core/types";

type Status = "pending" | "approved" | "rejected" | "expired";

function createEnv() {
  const approvals = new Map<string, { status: Status; requestedAt: number }>();
  const slackPosts: string[] = [];

  const doStub = {
    fetch: async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/deploy/approval" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        if (body.action === "request") {
          approvals.set(String(body.requestId), { status: "pending", requestedAt: Number(body.requestedAt ?? Date.now()) });
          return new Response("ok");
        }
        const current = approvals.get(String(body.requestId));
        if (!current) return new Response("missing", { status: 404 });
        current.status = String(body.status) as Status;
        approvals.set(String(body.requestId), current);
        return new Response("ok");
      }
      if (u.pathname === "/deploy/approval" && (!init || init.method === "GET")) {
        const id = u.searchParams.get("requestId") ?? "";
        const current = approvals.get(id);
        return new Response(JSON.stringify({ status: current?.status ?? "expired", requestedAt: current?.requestedAt }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  } as DurableObjectStub;

  const env = {
    AGENT_DO: {
      idFromName: (n: string) => n as unknown as DurableObjectId,
      get: () => doStub,
    },
    REPO_STORE: {
      get: async () => ({ json: async () => ({ allowedUserIds: ["U123"] }) }),
    },
    SANDBOX: {} as Env["SANDBOX"],
    SLACK_BOT_TOKEN: "x",
  } as unknown as Env;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (String(_url).includes("chat.postMessage")) {
      const payload = JSON.parse(String(init?.body ?? "{}"));
      slackPosts.push(String(payload.text));
      return new Response("ok");
    }
    return originalFetch(_url, init);
  }) as typeof fetch;

  return { env, approvals, slackPosts, restore: () => { globalThis.fetch = originalFetch; } };
}

test("approval flow enforces allowlist and handles status transitions", async () => {
  const { env, approvals, slackPosts, restore } = createEnv();
  try {
    const requestId = await requestApproval("diff", "C1", env);
    assert.equal(approvals.get(requestId)?.status, "pending");
    assert.ok(slackPosts.some((entry) => entry.includes(requestId)));

    const denied = await processApprovalMessage(`approve ${requestId}`, "U999", env);
    assert.equal(denied, false);
    assert.equal(await checkApproval(requestId, env), "pending");

    const ok = await processApprovalMessage(`approve ${requestId}`, "U123", env);
    assert.equal(ok, true);
    assert.equal(await checkApproval(requestId, env), "approved");
  } finally {
    restore();
  }
});

test("expired approval returns expired state", async () => {
  const { env, approvals, restore } = createEnv();
  try {
    approvals.set("old", { status: "pending", requestedAt: Date.now() - (31 * 60 * 1000) });
    const status = await checkApproval("old", env);
    assert.equal(status, "expired");
  } finally {
    restore();
  }
});
