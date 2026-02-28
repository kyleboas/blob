import type { Env } from "./types";
import { startCodexLogin, saveCodexAuth, sandboxStatus } from "./sandbox";
import { getRepos, addRepo } from "./storage";

interface SetupStep {
  name: string;
  description: string;
  check: (env: Env) => Promise<{ complete: boolean; message?: string }>;
  run: (env: Env) => Promise<{ success: boolean; message: string; nextStep?: string }>;
}

const SETUP_STEPS: SetupStep[] = [
  {
    name: "Sandbox Check",
    description: "Verify sandbox container is available",
    check: async (env) => {
      const status = await sandboxStatus(env);
      return { complete: status.ready, message: status.message };
    },
    run: async (env) => {
      const status = await sandboxStatus(env);
      if (status.ready) {
        return { success: true, message: "✅ Sandbox is ready" };
      }
      return { success: false, message: `❌ Sandbox not available: ${status.message}` };
    }
  },
  {
    name: "Codex Authentication",
    description: "Login to OpenAI Codex for AI coding tasks",
    check: async (env) => {
      // Check if auth exists by trying to run a simple command
      try {
        const { SandboxResult } = await import("./sandbox");
        // We can't directly check auth, but we can infer from previous setup
        return { complete: false, message: "Auth status unknown - run setup to check" };
      } catch {
        return { complete: false };
      }
    },
    run: async (env) => {
      return { 
        success: true, 
        message: "🔐 Starting Codex login...\n\nI'll post the login instructions in the channel.",
        nextStep: "codex_login"
      };
    }
  },
  {
    name: "Default Repository",
    description: "Set your primary GitHub repository",
    check: async (env) => {
      const repos = await getRepos(env);
      return { complete: repos.length > 0, message: repos.length > 0 ? `Found: ${repos[0]}` : "No repos configured" };
    },
    run: async (env) => {
      return { 
        success: true, 
        message: "📦 Repository setup required.\n\nTell me: 'my repo is owner/repo'",
        nextStep: "repo_setup"
      };
    }
  },
  {
    name: "Complete",
    description: "Setup complete - Blob is ready!",
    check: async () => ({ complete: true }),
    run: async () => ({ success: true, message: "🎉 Setup complete! Blob is ready to help." })
  }
];

export async function runSetupWizard(
  env: Env,
  onMessage: (msg: string) => Promise<void>
): Promise<{ complete: boolean; results: string[] }> {
  const results: string[] = [];
  
  await onMessage("🚀 **Blob Setup Wizard**\n\nChecking your configuration...");
  
  for (const step of SETUP_STEPS) {
    const check = await step.check(env);
    
    if (check.complete) {
      results.push(`✅ ${step.name}: ${check.message || "Complete"}`);
      continue;
    }
    
    await onMessage(`\n**${step.name}**\n${step.description}\nStatus: ${check.message || "Not configured"}`);
    
    const result = await step.run(env);
    results.push(`${result.success ? "✅" : "❌"} ${step.name}: ${result.message}`);
    
    await onMessage(result.message);
    
    // Special handling for Codex login
    if (result.nextStep === "codex_login") {
      const login = await startCodexLogin(env);
      await onMessage(
        `\n🔐 **Codex Login**\n\n` +
        `1. Open: ${login.url}\n` +
        `2. Enter code: \`${login.code || "see instructions"}\`\n` +
        `3. Complete login on your device\n` +
        `4. Reply with "done" when finished`
      );
      // Return early - user needs to complete login manually
      return { complete: false, results };
    }
    
    // Special handling for repo setup
    if (result.nextStep === "repo_setup") {
      return { complete: false, results };
    }
  }
  
  return { complete: true, results };
}

export async function completeCodexSetup(env: Env): Promise<{ success: boolean; message: string }> {
  try {
    const saved = await saveCodexAuth(env);
    if (saved.saved) {
      return { success: true, message: "✅ Codex authentication saved!" };
    }
    return { success: false, message: "❌ No auth found. Did you complete the login?" };
  } catch (err) {
    return { success: false, message: `❌ Error: ${err}` };
  }
}

export function getSetupHelp(): string {
  return `
🚀 **Blob Setup Commands**

Start setup: "setup blob" or "run setup"
Check status: "setup status"
Codex login: "login to codex"
Set repo: "my repo is owner/repo"

During setup, reply "done" after completing each step.
`;
}