import { APPROVAL_TIMEOUT_MINUTES } from "./config";
import type { postApprovalRequest, postMessage } from "./slack";
import type { SqlStorage } from "./storage";
import { saveApprovalDecision } from "./storage";

export interface PendingApproval {
  sessionId: string;
  command: string;
  channel: string;
  threadTs: string;
  requestedAtMs: number;
}

export interface ApprovalStorage {
  setAlarm?: (scheduledTime: number | Date) => Promise<void> | void;
}

export interface ApprovalDeps {
  postSlackApproval: typeof postApprovalRequest;
  postSlackMessage: typeof postMessage;
  now: () => number;
}

export async function createApprovalRequest(
  pendingApprovals: Map<string, PendingApproval>,
  approval: Omit<PendingApproval, "requestedAtMs">,
  deps: ApprovalDeps,
  token: string,
  storage?: ApprovalStorage
): Promise<void> {
  const requestedAtMs = deps.now();
  pendingApprovals.set(approval.threadTs, { ...approval, requestedAtMs });

  const timeoutMs = APPROVAL_TIMEOUT_MINUTES * 60 * 1000;
  await storage?.setAlarm?.(requestedAtMs + timeoutMs);

  await deps.postSlackApproval(
    token,
    approval.channel,
    approval.threadTs,
    `The agent wants to run:\n\`${approval.command}\``
  );
}

export async function resolveApprovalReaction(
  event: { thread_ts?: string; ts?: string; reaction?: string; user?: string },
  pendingApprovals: Map<string, PendingApproval>,
  deps: ApprovalDeps,
  token: string,
  sql: SqlStorage,
  executeApprovedCommand: (command: string) => Promise<{ exitCode: number }>
): Promise<void> {
  const threadTs = event.thread_ts ?? event.ts;
  if (!threadTs) return;

  const pending = pendingApprovals.get(threadTs);
  if (!pending) return;

  if (event.reaction === "thumbsup") {
    pendingApprovals.delete(threadTs);
    saveApprovalDecision(sql, pending.sessionId, pending.command, "approved", event.user ?? null);
    const result = await executeApprovedCommand(pending.command);
    await deps.postSlackMessage(
      token,
      pending.channel,
      `Approval received. Command finished with exit code ${result.exitCode}.`,
      pending.threadTs
    );
    return;
  }

  if (event.reaction === "thumbsdown") {
    pendingApprovals.delete(threadTs);
    saveApprovalDecision(sql, pending.sessionId, pending.command, "denied", event.user ?? null);
    await deps.postSlackMessage(token, pending.channel, "Approval denied. I did not execute the command.", pending.threadTs);
  }
}

export async function expireTimedOutApprovals(
  pendingApprovals: Map<string, PendingApproval>,
  deps: ApprovalDeps,
  token: string,
  sql: SqlStorage
): Promise<void> {
  const timeoutMs = APPROVAL_TIMEOUT_MINUTES * 60 * 1000;
  const now = deps.now();

  for (const [threadTs, pending] of pendingApprovals.entries()) {
    if (now - pending.requestedAtMs > timeoutMs) {
      pendingApprovals.delete(threadTs);
      saveApprovalDecision(sql, pending.sessionId, pending.command, "timed_out", null);
      await deps.postSlackMessage(token, pending.channel, "Approval timed out. Command was not executed.", pending.threadTs);
    }
  }
}
