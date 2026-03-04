export type DeployMechanism =
  | { type: "webhook"; url: string; headers?: Record<string, string> }
  | { type: "cloudflare_pages"; hookUrl: string }
  | { type: "github_actions"; owner: string; repo: string; workflowId: string; ref: string; token: string }
  | { type: "none" };

export interface DeployTriggerResult {
  status: "triggered" | "skipped";
  idempotencyKey: string;
  details: string;
}

export function buildDeployIdempotencyKey(mergeSha: string): string {
  return `deploy:${mergeSha}`;
}

export function buildDeployTriggerRequest(mechanism: DeployMechanism, mergeSha: string): { url: string; init: RequestInit } | null {
  const idempotencyKey = buildDeployIdempotencyKey(mergeSha);

  if (mechanism.type === "none") return null;

  if (mechanism.type === "webhook") {
    return {
      url: mechanism.url,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", "x-idempotency-key": idempotencyKey, ...(mechanism.headers || {}) },
        body: JSON.stringify({ merge_sha: mergeSha }),
      },
    };
  }

  if (mechanism.type === "cloudflare_pages") {
    return {
      url: mechanism.hookUrl,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", "x-idempotency-key": idempotencyKey },
        body: JSON.stringify({ merge_sha: mergeSha }),
      },
    };
  }

  return {
    url: `https://api.github.com/repos/${mechanism.owner}/${mechanism.repo}/actions/workflows/${mechanism.workflowId}/dispatches`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mechanism.token}`,
        accept: "application/vnd.github+json",
        "x-idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ ref: mechanism.ref, inputs: { merge_sha: mergeSha } }),
    },
  };
}

export async function triggerDeploy(
  mechanism: DeployMechanism,
  mergeSha: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeployTriggerResult> {
  const req = buildDeployTriggerRequest(mechanism, mergeSha);
  const idempotencyKey = buildDeployIdempotencyKey(mergeSha);

  if (!req) {
    return {
      status: "skipped",
      idempotencyKey,
      details: "Deploy mechanism is not configured. Manual deploy is required.",
    };
  }

  const response = await fetchImpl(req.url, req.init);
  if (!response.ok) {
    throw new Error(`Deploy trigger failed: ${response.status} ${await response.text()}`);
  }

  return {
    status: "triggered",
    idempotencyKey,
    details: `Triggered deploy via ${mechanism.type}`,
  };
}

export async function pollDeployStatus(
  getStatus: () => Promise<"pending" | "success" | "failure">,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<"success" | "failure" | "timeout"> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 5000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const status = await getStatus();
    if (status === "success" || status === "failure") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return "timeout";
}

export function formatDeploySlackMessage(status: "success" | "failure" | "timeout" | "skipped", details?: string): string {
  if (status === "success") return `✅ Deploy succeeded${details ? `: ${details}` : ""}`;
  if (status === "failure") return `❌ Deploy failed${details ? `: ${details}` : ""}`;
  if (status === "timeout") return `⚠️ Deploy status timed out${details ? `: ${details}` : ""}`;
  return `ℹ️ Deploy skipped. Manual deploy required${details ? `: ${details}` : ""}`;
}
