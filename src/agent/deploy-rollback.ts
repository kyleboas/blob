import type { Env } from "../core/types";

export async function monitorPostDeploy(env: Env, heartbeatCount: number): Promise<"healthy" | "unhealthy"> {
  const do_ = env.AGENT_DO.get(env.AGENT_DO.idFromName("blob"));
  const res = await do_.fetch("http://do/heartbeat/status");
  if (!res.ok) return "unhealthy";
  const data = await res.json() as { jobs?: { running?: number }; consecutiveHeartbeatFailures?: number };
  const failures = data.consecutiveHeartbeatFailures ?? 0;
  return failures >= heartbeatCount ? "unhealthy" : "healthy";
}

export async function rollback(env: Env): Promise<void> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.ACCOUNT_ID || !env.WORKER_NAME) {
    throw new Error("Missing rollback configuration");
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/workers/scripts/${env.WORKER_NAME}/rollback`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Rollback failed: ${res.status} ${await res.text()}`);
  }

  if (env.SLACK_BOT_TOKEN && env.SLACK_SUMMARY_CHANNEL) {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: env.SLACK_SUMMARY_CHANNEL,
        text: "🚨 Auto-rollback executed after consecutive post-deploy heartbeat failures.",
      }),
    });
  }
}
