import { APPROVAL_TIMEOUT_MINUTES } from "./config";
import type { postApprovalRequest, postMessage } from "./slack";
import type { SqlStorage } from "./storage";
import { saveApprovalDecision } from "./storage";

export interface PendingApproval {
  sessionId: string;
  command: string;
  channel: string;
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

  const { ts: approvalMsgTs } = await deps.postSlackApproval(
    token,
    approval.channel,
    `The agent wants to run:\n\`${approval.command}\``
  );

  pendingApprovals.set(approvalMsgTs, { ...approval, requestedAtMs });

  const timeoutMs = APPROVAL_TIMEOUT_MINUTES * 60 * 1000;
  await storage?.setAlarm?.(requestedAtMs + timeoutMs);
}

export async function resolveApprovalReaction(
  event: { item?: { ts?: string }; reaction?: string; user?: string },
  pendingApprovals: Map<string, PendingApproval>,
  deps: ApprovalDeps,
  token: string,
  sql: SqlStorage,
  executeApprovedCommand: (command: string) => Promise<{ exitCode: number }>
): Promise<void> {
  const approvalMsgTs = event.item?.ts;
  if (!approvalMsgTs) return;

  const pending = pendingApprovals.get(approvalMsgTs);
  if (!pending) return;

  if (event.reaction === "thumbsup") {
    pendingApprovals.delete(approvalMsgTs);
    saveApprovalDecision(sql, pending.sessionId, pending.command, "approved", event.user ?? null);
    const result = await executeApprovedCommand(pending.command);
    await deps.postSlackMessage(
      token,
      pending.channel,
      `Approval received. Command finished with exit code ${result.exitCode}.`
    );
    return;
  }

  if (event.reaction === "thumbsdown") {
    pendingApprovals.delete(approvalMsgTs);
    saveApprovalDecision(sql, pending.sessionId, pending.command, "denied", event.user ?? null);
    await deps.postSlackMessage(token, pending.channel, "Approval denied. I did not execute the command.");
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

  for (const [approvalKey, pending] of pendingApprovals.entries()) {
    if (now - pending.requestedAtMs > timeoutMs) {
      pendingApprovals.delete(approvalKey);
      saveApprovalDecision(sql, pending.sessionId, pending.command, "timed_out", null);
      await deps.postSlackMessage(token, pending.channel, "Approval timed out. Command was not executed.");
    }
  }
}
