import { describe, expect, it, vi } from "vitest";
import { createApprovalRequest, expireTimedOutApprovals, resolveApprovalReaction, type PendingApproval } from "./approval";
import type { SqlStorage } from "./storage";

class FakeSql implements SqlStorage {
  public logs: Array<{ sessionId: string; command: string; decision: string; decidedBy: string | null }> = [];

  exec(query: string, ...bindings: Array<string | number | null>) {
    const normalized = query.trim().replace(/\s+/g, " ");
    if (normalized.startsWith("INSERT INTO approval_log")) {
      this.logs.push({
        sessionId: String(bindings[0]),
        command: String(bindings[1]),
        decision: String(bindings[2]),
        decidedBy: bindings[3] == null ? null : String(bindings[3])
      });
    }
    return { toArray: () => [] };
  }
}

describe("approval helpers", () => {
  it("creates approval requests and schedules alarm", async () => {
    const pending = new Map<string, PendingApproval>();
    const setAlarm = vi.fn();
    const postSlackApproval = vi.fn().mockResolvedValue({ ts: "approval-ts" });

    await createApprovalRequest(
      pending,
      { sessionId: "s1", command: "rm -rf tmp", channel: "C1" },
      { postSlackApproval: postSlackApproval as never, postSlackMessage: vi.fn() as never, now: () => 1_000 },
      "token",
      { setAlarm }
    );

    expect(pending.get("approval-ts")?.requestedAtMs).toBe(1_000);
    expect(setAlarm).toHaveBeenCalled();
    expect(postSlackApproval).toHaveBeenCalledTimes(1);
  });

  it("resolves approved reactions and records decisions", async () => {
    const pending = new Map<string, PendingApproval>([["t1", {
      sessionId: "s1", command: "git reset --hard", channel: "C1", requestedAtMs: 0
    }]]);
    const sql = new FakeSql();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);
    const execApproved = vi.fn().mockResolvedValue({ exitCode: 0 });

    await resolveApprovalReaction(
      { reaction: "thumbsup", item: { ts: "t1" }, user: "U1" },
      pending,
      { postSlackApproval: vi.fn() as never, postSlackMessage: postSlackMessage as never, now: () => 0 },
      "token",
      sql,
      execApproved
    );

    expect(execApproved).toHaveBeenCalledWith("git reset --hard");
    expect(sql.logs[0]).toEqual({ sessionId: "s1", command: "git reset --hard", decision: "approved", decidedBy: "U1" });
  });

  it("expires timed out approvals", async () => {
    const pending = new Map<string, PendingApproval>([["t1", {
      sessionId: "s1", command: "rm -rf tmp", channel: "C1", requestedAtMs: 0
    }]]);
    const sql = new FakeSql();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    await expireTimedOutApprovals(
      pending,
      { postSlackApproval: vi.fn() as never, postSlackMessage: postSlackMessage as never, now: () => 31 * 60 * 1000 },
      "token",
      sql
    );

    expect(pending.size).toBe(0);
    expect(sql.logs[0]?.decision).toBe("timed_out");
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
  });
});
