import type { Env } from "./types";

export async function callLLM(
  messages: Array<{ role: string; content: string }>,
  env: Env,
  opts: { maxTokens?: number } = {}
): Promise<string> {
  const response = await fetch(`${env.AI_GATEWAY_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8",
      messages,
      max_tokens: opts.maxTokens ?? 4096,
    }),
  });
  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

export async function plan(goals: string[], env: Env): Promise<string> {
  const prompt = `You are an autonomous coding agent.\n\nRepository goals:\n${goals.map(g => `- ${g}`).join("\n")}\n\nWhat is ONE specific task to work on next? Respond with only the task description.`;
  return (await callLLM([{ role: "user", content: prompt }], env)).trim();
}
