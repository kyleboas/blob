import { describe, expect, it, vi } from "vitest";
import { SandboxClient, truncateOutput, validateCommand } from "./sandbox-client";

describe("validateCommand", () => {
  it("rejects command injection pattern", () => {
    const result = validateCommand("echo $(cat /etc/passwd)");
    expect(result.allowed).toBe(false);
  });

  it("allows benign command", () => {
    const result = validateCommand("ls -la");
    expect(result.allowed).toBe(true);
  });
});

describe("truncateOutput", () => {
  it("truncates long output", () => {
    const output = "a".repeat(20);
    const truncated = truncateOutput(output, 10);
    expect(truncated).toContain("...[truncated 10 chars]");
  });
});

describe("SandboxClient", () => {
  it("executes command through sandbox binding", async () => {
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
      writeFile: vi.fn(),
      readFile: vi.fn()
    };

    const client = new SandboxClient(sandbox);
    const result = await client.exec("echo ok");

    expect(result).toMatchObject({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
    // The command is wrapped with bash -c and env file sourcing; check key parts.
    const calledWith = sandbox.exec.mock.calls[0][0] as string;
    expect(calledWith).toContain("echo ok");
    expect(calledWith).toContain(".blob-env");
    expect(calledWith).toMatch(/^bash -o pipefail -c '/);
  });

  it("returns timeout response for long running command", async () => {
    const sandbox = {
      exec: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ stdout: "", stderr: "", exitCode: 0 }), 50))
      ),
      writeFile: vi.fn(),
      readFile: vi.fn()
    };

    const client = new SandboxClient(sandbox);
    const result = await client.exec("sleep 60", 0.01);

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it("truncates stdout and stderr", async () => {
    const longOutput = "a".repeat(20);
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ stdout: longOutput, stderr: longOutput, exitCode: 0 }),
      writeFile: vi.fn(),
      readFile: vi.fn()
    };

    const client = new SandboxClient(sandbox, 10);
    const result = await client.exec("echo hi");

    expect(result.stdout).toContain("...[truncated 10 chars]");
    expect(result.stderr).toContain("...[truncated 10 chars]");
  });

  it("supports write/read/fileExists", async () => {
    const sandbox = {
      exec: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi
        .fn()
        .mockResolvedValueOnce("content")
        .mockResolvedValueOnce("content")
        .mockRejectedValueOnce(new Error("not found"))
    };

    const client = new SandboxClient(sandbox);
    await client.writeFile("foo.txt", "hello");
    const text = await client.readFile("foo.txt");
    const exists = await client.fileExists("foo.txt");
    const missing = await client.fileExists("missing.txt");

    expect(text).toBe("content");
    expect(exists).toBe(true);
    expect(missing).toBe(false);
  });

  it("retries transient durable object startup errors on read", async () => {
    const sandbox = {
      exec: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi
        .fn()
        .mockRejectedValueOnce(new Error("A call to blockConcurrencyWhile() in a Durable Object waited for too long."))
        .mockResolvedValueOnce("content")
    };

    const client = new SandboxClient(sandbox, 10_000, 0);
    const result = await client.readFile("AGENT.md");

    expect(result).toBe("content");
    expect(sandbox.readFile).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient read errors", async () => {
    const sandbox = {
      exec: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn().mockRejectedValue(new Error("not found"))
    };

    const client = new SandboxClient(sandbox, 10_000, 0);
    await expect(client.readFile("missing.txt")).rejects.toThrow("not found");
    expect(sandbox.readFile).toHaveBeenCalledTimes(1);
  });

  it("retries warmUp when writeFile times out (cold-start timeout is transient)", async () => {
    const sandbox = {
      exec: vi.fn(),
      writeFile: vi
        .fn()
        .mockRejectedValueOnce(new Error("Command timed out after 90 seconds"))
        .mockResolvedValueOnce(undefined),
      readFile: vi.fn()
    };

    const client = new SandboxClient(sandbox, 10_000, 0, 0);
    await client.warmUp();

    expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
  });

  it("retries warmUp on transient durable object errors", async () => {
    const sandbox = {
      exec: vi.fn(),
      writeFile: vi
        .fn()
        .mockRejectedValueOnce(new Error("HTTP error! Status: 500"))
        .mockResolvedValueOnce(undefined),
      readFile: vi.fn()
    };

    const client = new SandboxClient(sandbox, 10_000, 0, 0);
    await client.warmUp();

    expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
  });

  it("does not retry warmUp on non-transient errors", async () => {
    const sandbox = {
      exec: vi.fn(),
      writeFile: vi.fn().mockRejectedValue(new Error("permission denied")),
      readFile: vi.fn()
    };

    const client = new SandboxClient(sandbox, 10_000, 0);
    await expect(client.warmUp()).rejects.toThrow("permission denied");
    expect(sandbox.writeFile).toHaveBeenCalledTimes(1);
  });

  it("retries warmUp when container exits (code: 0)", async () => {
    const sandbox = {
      exec: vi.fn(),
      writeFile: vi
        .fn()
        .mockRejectedValueOnce(new Error("Container exited (code: 0)"))
        .mockResolvedValueOnce(undefined),
      readFile: vi.fn()
    };

    // Pass 0 for both delay params so the test runs without sleeping
    const client = new SandboxClient(sandbox, 10_000, 0, 0);
    await client.warmUp();

    expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
  });

  it("retries warmUp on HTTP 502 container restart error", async () => {
    const sandbox = {
      exec: vi.fn(),
      writeFile: vi
        .fn()
        .mockRejectedValueOnce(new Error("HTTP error! Status: 502"))
        .mockResolvedValueOnce(undefined),
      readFile: vi.fn()
    };

    const client = new SandboxClient(sandbox, 10_000, 0, 0);
    await client.warmUp();

    expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
  });

  it("exec re-warms and retries when container exits mid-session", async () => {
    const sandbox = {
      exec: vi
        .fn()
        .mockRejectedValueOnce(new Error("Container exited (code: 0)"))
        .mockResolvedValueOnce({ stdout: "output", stderr: "", exitCode: 0 }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn()
    };

    const client = new SandboxClient(sandbox, 10_000, 0, 0);
    const result = await client.exec("echo hi");

    expect(result.stdout).toBe("output");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    // warmUp was called (writes the probe file)
    expect(sandbox.writeFile).toHaveBeenCalledWith("/tmp/.blob-warmup", "ok");
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
  });

  it("exec returns error result when container restart fails after exit", async () => {
    const sandbox = {
      exec: vi.fn().mockRejectedValue(new Error("Container exited (code: 0)")),
      writeFile: vi.fn().mockRejectedValue(new Error("Container exited (code: 0)")),
      readFile: vi.fn()
    };

    const client = new SandboxClient(sandbox, 10_000, 0, 0);
    const result = await client.exec("echo hi");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });
});
