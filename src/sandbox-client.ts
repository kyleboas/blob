import { COMMAND_TIMEOUT } from "./config";

const DEFAULT_MAX_OUTPUT_CHARS = 10_000;
export const SANDBOX_ENV_FILE = "/workspace/.blob-env";
const TRANSIENT_SANDBOX_MAX_ATTEMPTS = 5;
const TRANSIENT_SANDBOX_RETRY_DELAY_MS = 2_000;
const WARM_UP_MAX_ATTEMPTS = 10;
export const WARM_UP_RETRY_DELAY_MS = 5_000;
const WARM_UP_TIMEOUT_MS = 90_000;

export interface SandboxExecResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface SandboxBinding {
  exec(command: string): Promise<SandboxExecResponse>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const COMMAND_INJECTION_PATTERNS = [
  /\$\(/,
  /`[^`]+`/,
  /\/etc\/(passwd|shadow|resolv\.conf)/i,
  /\b(?:curl|wget)\b[^\n]*(localhost|127\.0\.0\.1|::1|169\.254\.169\.254)/i
];

export function validateCommand(command: string): { allowed: boolean; reason?: string } {
  const normalized = command.trim();
  if (!normalized) {
    return { allowed: false, reason: "Empty command is not allowed." };
  }

  for (const pattern of COMMAND_INJECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        allowed: false,
        reason: `Command rejected by policy: matched disallowed pattern \`${pattern.source}\`.`
      };
    }
  }

  return { allowed: true };
}

export function truncateOutput(text: string, maxLength = DEFAULT_MAX_OUTPUT_CHARS): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Command timed out after ${Math.ceil(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

export class SandboxClient {
  constructor(
    private readonly sandbox: SandboxBinding,
    private readonly maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    private readonly retryDelayMs = TRANSIENT_SANDBOX_RETRY_DELAY_MS,
    private readonly warmUpRetryDelayMs = WARM_UP_RETRY_DELAY_MS
  ) {}

  private isTransientSandboxError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return message.includes("blockconcurrencywhile")
      || (message.includes("durable object") && message.includes("reset"))
      || message.includes("durable object is overloaded")
      || message.includes("durable object request failed")
      || (message.includes("http error") && message.includes("500"));
  }

  // Detects errors caused by the sandbox container exiting (code 0 or otherwise)
  // and becoming temporarily unavailable during a restart. These require a full
  // warm-up cycle rather than the shorter transient retry budget.
  private isContainerExitError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return message.includes("container exited")
      || message.includes("container has exited")
      || (message.includes("http error") && (message.includes("502") || message.includes("503")));
  }

  private async sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private async withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < TRANSIENT_SANDBOX_MAX_ATTEMPTS) {
      attempt += 1;
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!this.isTransientSandboxError(error) || attempt >= TRANSIENT_SANDBOX_MAX_ATTEMPTS) {
          throw error;
        }
        await this.sleep(this.retryDelayMs * attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Sandbox execution failed");
  }

  async exec(command: string, timeoutSeconds = COMMAND_TIMEOUT): Promise<ExecResult> {
    const commandValidation = validateCommand(command);
    if (!commandValidation.allowed) {
      return {
        stdout: "",
        stderr: commandValidation.reason ?? "Command rejected by policy.",
        exitCode: 1,
        timedOut: false
      };
    }

    // Wrap with pipefail so that a failing command in a pipeline (e.g. git clone ... | head -20)
    // propagates the non-zero exit code instead of returning head's exit code of 0.
    // Source the secrets env file if present so that GITHUB_TOKEN and other Cloudflare
    // secrets are available to every command without being embedded in the command string.
    //
    // Single-quote the bash -c argument to prevent any outer shell layer (e.g. the
    // Cloudflare sandbox runner) from expanding ${VAR} references before bash sources
    // the env file.  We escape embedded single quotes using the standard '\\'' trick.
    const innerCommand = `[ -f ${SANDBOX_ENV_FILE} ] && . ${SANDBOX_ENV_FILE} 2>/dev/null; ${command}`;
    const escapedInner = innerCommand.replace(/'/g, "'\\''");
    const wrappedCommand = `bash -o pipefail -c '${escapedInner}'`;

    try {
      const response = await this.withTransientRetry(
        () => withTimeout(this.sandbox.exec(wrappedCommand), timeoutSeconds * 1000)
      );
      return {
        stdout: truncateOutput(response.stdout ?? "", this.maxOutputChars),
        stderr: truncateOutput(response.stderr ?? "", this.maxOutputChars),
        exitCode: response.exitCode ?? 0,
        timedOut: false
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("timed out")) {
        return {
          stdout: "",
          stderr: error.message,
          exitCode: 124,
          timedOut: true
        };
      }

      // Container exited mid-session (e.g. code: 0 idle shutdown). Warm it
      // back up and retry the command once so the agent loop can continue
      // rather than returning a spurious error to the LLM.
      if (this.isContainerExitError(error)) {
        try {
          await this.warmUp();
          const response = await withTimeout(this.sandbox.exec(wrappedCommand), timeoutSeconds * 1000);
          return {
            stdout: truncateOutput(response.stdout ?? "", this.maxOutputChars),
            stderr: truncateOutput(response.stderr ?? "", this.maxOutputChars),
            exitCode: response.exitCode ?? 0,
            timedOut: false
          };
        } catch {
          // Warm-up or the post-restart retry failed; fall through to the
          // error result below so the LLM receives a clear error message.
        }
      }

      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : "Sandbox execution failed",
        exitCode: 1,
        timedOut: false
      };
    }
  }

  // Polls the sandbox with a generous retry budget until the container is
  // warm and accepting requests. Called before file writes during sandbox_start
  // to handle the cold-start window where the container returns HTTP 500.
  // Uses writeFile (not exec) as the probe because exec and the file-system
  // layer can initialise independently; we must confirm file I/O is ready.
  // Also retries when the container has exited and is restarting (code: 0).
  async warmUp(): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= WARM_UP_MAX_ATTEMPTS; attempt++) {
      try {
        await withTimeout(this.sandbox.writeFile("/tmp/.blob-warmup", "ok"), WARM_UP_TIMEOUT_MS);
        return;
      } catch (error) {
        lastError = error;
        const isTimeout = error instanceof Error && error.message.includes("timed out");
        const isTransient = this.isTransientSandboxError(error) || this.isContainerExitError(error) || isTimeout;
        if (!isTransient || attempt >= WARM_UP_MAX_ATTEMPTS) {
          throw error;
        }
        await this.sleep(this.warmUpRetryDelayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Sandbox failed to warm up");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.withTransientRetry(() => this.sandbox.writeFile(path, content));
  }

  async readFile(path: string): Promise<string> {
    return this.withTransientRetry(() => this.sandbox.readFile(path));
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await this.withTransientRetry(() => this.sandbox.readFile(path));
      return true;
    } catch {
      return false;
    }
  }
}
