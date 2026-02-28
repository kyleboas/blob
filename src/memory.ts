import type { Env } from "./types";

const MEMORY_DO_ID = "memory";

async function getMemoryDO(env: Env): Promise<DurableObjectStub> {
  if (!env.MEMORY) {
    throw new Error("MEMORY binding not found");
  }
  const id = env.MEMORY.idFromName(MEMORY_DO_ID);
  return env.MEMORY.get(id);
}

export async function saveMessage(env: Env, role: string, content: string): Promise<void> {
  try {
    const do_ = await getMemoryDO(env);
    await do_.fetch("http://do/messages", {
      method: "POST",
      body: JSON.stringify({ role, content }),
    });
  } catch (err) {
    console.error("Failed to save message:", err);
  }
}

export async function getRecentMessages(env: Env, limit = 10): Promise<Array<{ role: string; content: string; timestamp: number }>> {
  try {
    const do_ = await getMemoryDO(env);
    const res = await do_.fetch(`http://do/messages?limit=${limit}`);
    const data = await res.json() as { messages: Array<{ role: string; content: string; timestamp: number }> };
    return data.messages;
  } catch (err) {
    console.error("Failed to get messages:", err);
    return [];
  }
}

export async function savePreference(env: Env, key: string, value: string): Promise<void> {
  try {
    const do_ = await getMemoryDO(env);
    await do_.fetch("http://do/preferences", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    });
  } catch (err) {
    console.error("Failed to save preference:", err);
  }
}

export async function getMemory(env: Env): Promise<{ messages: Array<unknown>; userPreferences: Record<string, string>; context: Record<string, unknown> }> {
  try {
    const do_ = await getMemoryDO(env);
    const res = await do_.fetch("http://do/memory");
    return await res.json() as { messages: Array<unknown>; userPreferences: Record<string, string>; context: Record<string, unknown> };
  } catch (err) {
    console.error("Failed to get memory:", err);
    return { messages: [], userPreferences: {}, context: {} };
  }
}
