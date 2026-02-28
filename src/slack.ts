import type { Env } from "./types";
import { getRepos, addRepo, getRepoGoals, setRepoGoals } from "./storage";
import { Agent } from "./agent";

export async function handleSlackEvent(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    type?: string;
    challenge?: string;
    event?: {
      type: string;
      text?: string;
      channel?: string;
      user?: string;
    };
  };

  // Slack URL verification
  if (body.type === "url_verification" && body.challenge) {
    return new Response(body.challenge);
  }

  // Handle message events
  if (body.type === "event_callback" && body.event?.type === "message" && body.event.text) {
    const text = body.event.text.toLowerCase();
    const channel = body.event.channel;

    // Ignore bot messages
    if (!channel) return new Response("OK");

    // Handle commands
    if (text.includes("show repos")) {
      const repos = await getRepos(env);
      await postToSlack(channel, `Repos: ${repos.join(", ")}`, env);
    }
    else if (text.includes("add repo")) {
      const match = body.event.text.match(/add repo\s+(\S+)/i);
      if (match) {
        await addRepo(env, match[1]);
        await postToSlack(channel, `Added repo: ${match[1]}`, env);
      }
    }
    else if (text.includes("set goals")) {
      const match = body.event.text.match(/set goals for\s+(\S+)\s*:\s*(.+)/i);
      if (match) {
        const repo = match[1];
        const goals = match[2].split(";").map(g => g.trim());
        await setRepoGoals(env, repo, goals);
        await postToSlack(channel, `Set goals for ${repo}: ${goals.join(", ")}`, env);
      }
    }
    else if (text.includes("run")) {
      const repos = await getRepos(env);
      repos.forEach(r => new Agent(r, [], env).run().catch(console.error));
      await postToSlack(channel, `Running on: ${repos.join(", ")}`, env);
    }
    else if (text.includes("help")) {
      await postToSlack(channel, 
        "Commands:\n" +
        "• show repos\n" +
        "• add repo owner/repo\n" +
        "• set goals for owner/repo: goal1; goal2\n" +
        "• run", env);
    }
  }

  return new Response("OK");
}

async function postToSlack(channel: string, text: string, env: Env): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) {
    console.log("No SLACK_BOT_TOKEN, skipping Slack post");
    return;
  }

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text,
    }),
  });
}
