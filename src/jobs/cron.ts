import type { Env } from "../core/types";
import { withDOAuth } from "../core/do-auth";

const BLOB_ID = "blob";

async function getAgentDO(env: Env): Promise<DurableObjectStub> {
  if (!env.AGENT_DO) throw new Error("AGENT_DO binding not found");
  return env.AGENT_DO.get(env.AGENT_DO.idFromName(BLOB_ID));
}

export async function getCronJobs(env: Env): Promise<Array<{ id: string; schedule: string; task: string; enabled: boolean }>> {
  try {
    const do_ = await getAgentDO(env);
    const res = await do_.fetch("http://do/cron", withDOAuth(env));
    const data = await res.json() as { jobs: Array<{ id: string; schedule: string; task: string; enabled: boolean }> };
    return data.jobs;
  } catch {
    return [];
  }
}

export async function addCronJob(env: Env, schedule: string, task: string): Promise<{ id: string } | null> {
  try {
    const do_ = await getAgentDO(env);
    const res = await do_.fetch("http://do/cron", withDOAuth(env, {
      method: "POST",
      body: JSON.stringify({ schedule, task }),
    }));
    const data = await res.json() as { created: { id: string } };
    return { id: data.created.id };
  } catch {
    return null;
  }
}

export async function deleteCronJob(env: Env, id: string): Promise<boolean> {
  try {
    const do_ = await getAgentDO(env);
    await do_.fetch("http://do/cron/delete", withDOAuth(env, {
      method: "POST",
      body: JSON.stringify({ id }),
    }));
    return true;
  } catch {
    return false;
  }
}
