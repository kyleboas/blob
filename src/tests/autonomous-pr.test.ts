import test from "node:test";
import assert from "node:assert/strict";
import { maybeOpenAutonomousPullRequest } from "../agent/autonomous-pr";
import type { Env } from "../core/types";

function makeEnv(execImpl: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>): Env {
  return {
    AGENT_DO: {} as DurableObjectNamespace,
    SANDBOX: {
      start: async () => undefined,
      exec: execImpl,
      writeFile: async () => undefined,
      readFile: async () => "",
    },
    REPO_STORE: {
      get: async () => null,
    } as R2Bucket,
    GITHUB_TOKEN: "github-token",
    AI_GATEWAY_BASE_URL: "https://gateway.example",
    AI_GATEWAY_TOKEN: "x",
  } as Env;
}

test("autonomous PR hook opens a PR for verified background changes", async () => {
  const commands: string[] = [];
  const statusCalls: string[] = [];
  const env = makeEnv(async (command: string) => {
    commands.push(command);
    if (command.includes("# blob-detect-verify-command")) {
      return { stdout: "npm test\n", stderr: "", exitCode: 0 };
    }
    if (command.includes("npm test")) {
      return { stdout: "ok", stderr: "", exitCode: 0 };
    }
    if (command.includes("git status --porcelain")) {
      statusCalls.push(command);
      return { stdout: " M src/index.ts\n", stderr: "", exitCode: 0 };
    }
    if (command.includes("git symbolic-ref refs/remotes/origin/HEAD")) {
      return { stdout: "main\n", stderr: "", exitCode: 0 };
    }
    if (command.includes("git diff --cached --no-ext-diff")) {
      return { stdout: "diff --git a/src/index.ts b/src/index.ts\n+const x = 1;\n", stderr: "", exitCode: 0 };
    }
    if (command.includes("git rev-parse HEAD")) {
      return { stdout: "abc123\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });

  const originalFetch = globalThis.fetch;
  const fetchedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchedUrls.push(url);
    if (url.includes("/pulls?state=open")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(
      JSON.stringify({ number: 42, html_url: "https://github.com/kyleboas/blob/pull/42", state: "open" }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await maybeOpenAutonomousPullRequest({
      env,
      repo: "kyleboas/blob",
      task: "Fix the flaky auth test",
      jobId: "autonomy-job-1234",
      sandboxId: "autonomy-blob",
      diagnosisSummary: "Verification failed in auth tests.",
    });

    assert.equal(result.status, "opened");
    assert.equal(result.url, "https://github.com/kyleboas/blob/pull/42");
    assert.ok(commands.some((command) => command.includes("test -d .git")));
    assert.ok(commands.some((command) => command.includes("git checkout -B") && command.includes("blob-autonomy/autonomy-job")));
    assert.ok(commands.some((command) => command.includes("git push -u origin") && command.includes("blob-autonomy/autonomy-job")));
    assert.ok(fetchedUrls.some((url) => url.includes("/pulls?state=open")));
    assert.ok(fetchedUrls.some((url) => url.endsWith("/pulls")));
    assert.equal(statusCalls.length >= 1, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("autonomous PR hook skips PR creation when verification fails", async () => {
  const env = makeEnv(async (command: string) => {
    if (command.includes("# blob-detect-verify-command")) {
      return { stdout: "npm test\n", stderr: "", exitCode: 0 };
    }
    if (command.includes("npm test")) {
      return { stdout: "", stderr: "still broken", exitCode: 1 };
    }
    if (command.includes("test -d .git")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });

  const result = await maybeOpenAutonomousPullRequest({
    env,
    repo: "kyleboas/blob",
    task: "Fix the flaky auth test",
    jobId: "autonomy-job-2345",
    sandboxId: "autonomy-blob",
  });

  assert.equal(result.status, "skipped");
  assert.match(result.reason, /verification failed/);
});
