/**
 * Python Bridge - Integrates Python code generation with TypeScript agent
 * 
 * This module provides the hybrid approach:
 * - TypeScript orchestration (infrastructure, DO, sandbox)
 * - Python subprocess for code generation logic
 * - Python generates TypeScript, TS compiles and deploys
 */

import type { SandboxBinding } from "./sandbox-client";

// SqlStorage type from agent.ts context
type SqlStorage = {
  exec: (query: string, ...bindings: (string | number | null)[]) => { toArray: () => Array<Record<string, unknown>> };
};

export interface PythonGenerationResult {
  success: boolean;
  code?: string;
  explanation?: string;
  action?: "add_method" | "add_tool" | "modify_method";
  error?: string;
}

export interface SelfModificationPlan {
  files: Record<string, string>;
  explanation: string[];
  warnings: string[];
}

// Check if Python generation is enabled (can be disabled via setting)
export function isPythonGenerationEnabled(db: SqlStorage): boolean {
  const result = db.exec("SELECT value FROM settings WHERE key = ?", "use_python_generation");
  const rows = result.toArray();
  if (rows.length > 0) {
    return String(rows[0].value) !== "false";
  }
  return true; // Enabled by default
}

/**
 * Generate TypeScript code using Python subprocess
 * This is the core of the hybrid approach
 */
export async function generateWithPython(
  sandbox: SandboxBinding,
  task: string,
  currentCode?: string
): Promise<PythonGenerationResult> {
  try {
    // Write Python scripts to sandbox if not present
    await ensurePythonScripts(sandbox);
    
    // Prepare the Python command
    const pythonCmd = currentCode
      ? `python3 /sandbox/python/agent_generator.py '${escapeShellArg(task)}' '${escapeShellArg(currentCode)}'`
      : `python3 /sandbox/python/agent_generator.py '${escapeShellArg(task)}'`;
    
    // Execute Python in sandbox (timeout handled by sandbox)
    const result = await sandbox.exec(pythonCmd);
    
    if (result.exitCode !== 0) {
      return {
        success: false,
        error: `Python execution failed: ${result.stderr}`
      };
    }
    
    // Parse JSON output from Python
    const output = (result.stdout ?? "").trim();
    if (!output) {
      return {
        success: false,
        error: "Python produced no output"
      };
    }
    
    try {
      const parsed = JSON.parse(output) as PythonGenerationResult;
      return {
        success: true,
        code: parsed.code,
        explanation: parsed.explanation,
        action: parsed.action
      };
    } catch (parseError) {
      return {
        success: false,
        error: `Failed to parse Python output: ${output.slice(0, 200)}`
      };
    }
    
  } catch (error) {
    return {
      success: false,
      error: `Python generation error: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Advanced self-modification using the full Python engine
 */
export async function planSelfModification(
  sandbox: SandboxBinding,
  task: string,
  currentCode: string
): Promise<SelfModificationPlan | null> {
  try {
    await ensurePythonScripts(sandbox);
    
    const pythonCmd = `python3 /sandbox/python/self_modify.py '${escapeShellArg(task)}' '${escapeShellArg(currentCode)}'`;
    
    const result = await sandbox.exec(pythonCmd);
    
    if (result.exitCode !== 0) {
      console.error("[PYTHON] Self-modification planning failed:", result.stderr);
      return null;
    }
    
    const output = (result.stdout ?? "").trim();
    if (!output) return null;
    
    try {
      return JSON.parse(output) as SelfModificationPlan;
    } catch {
      console.error("[PYTHON] Failed to parse plan:", output.slice(0, 500));
      return null;
    }
    
  } catch (error) {
    console.error("[PYTHON] Planning error:", error);
    return null;
  }
}

/**
 * Ensure Python scripts are available in sandbox
 */
async function ensurePythonScripts(sandbox: SandboxBinding): Promise<void> {
  // Check if scripts exist
  const checkResult = await sandbox.exec("test -f /sandbox/python/agent_generator.py && echo 'exists'");
  
  if ((checkResult.stdout ?? "").trim() === "exists") {
    return; // Already exists
  }
  
  // Create directory and write scripts
  await sandbox.exec("mkdir -p /sandbox/python");
  
  // The scripts would be embedded here or fetched from a URL
  // For now, we assume they're mounted via the sandbox filesystem
  console.log("[PYTHON] Scripts not found in sandbox - ensure they're mounted");
}

/**
 * Escape string for shell command
 */
function escapeShellArg(arg: string): string {
  return arg
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "'\"'\"'")
    .replace(/\n/g, "\\n")
    .slice(0, 10000); // Limit length
}

/**
 * Log Python generation attempt for monitoring
 */
export function logPythonGeneration(
  forwardToLogs: (type: string, msg: string) => void,
  task: string,
  result: PythonGenerationResult
): void {
  if (result.success) {
    forwardToLogs("python_generation", `✓ Generated ${result.action} for: ${task.slice(0, 50)}...`);
  } else {
    forwardToLogs("python_generation", `✗ Failed: ${result.error?.slice(0, 100)}`);
  }
}
