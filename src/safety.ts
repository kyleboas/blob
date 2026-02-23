import {
  PROTECTED_FILES,
  SELF_MODIFY_LIMIT_DAY,
  SELF_MODIFY_LIMIT_SESSION
} from "./config";
import { getRateLimit, type SqlStorage } from "./storage";

export type CommandClassification = "auto_approve" | "conditional" | "requires_approval";

export interface SafetyDecision {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
}

export interface SafetyOptions {
  applySelfModificationRateLimit?: boolean;
}

const SELF_MOD_WRITE_PATTERNS = [
  /\b(sed|tee|truncate|touch|mv|cp|rm)\b/,
  />|>>/,
  /\b(git\s+commit|git\s+add|python|npm)\b/
];

const SELF_MOD_TARGET_PATTERNS = [
  /\b(src|tests?|scripts|docs)\//,
  /\b(agent\.py|safety\.py|approval\.py|config\.py|blob_config\.py)\b/,
  /\.(ts|tsx|js|jsx|py|md|json|toml|yaml|yml)\b/
];

const AUTO_APPROVE_PATTERNS = [
  /^(cat|ls|pwd|echo|head|tail|wc|find|grep|git\s+status)\b/
];

const REQUIRES_APPROVAL_PATTERNS = [
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-fd/,
  /rm\s+-rf/,
  /git\s+push\s+--force/
];

const CONDITIONAL_PATTERNS = [
  /^git\s+add\b/,
  /^git\s+commit\b/,
  /^sed\b/,
  /^tee\b/,
  /^echo\b.*>/,
  /^python\b/,
  /^npm\b/
];

export function checkRateLimit(
  sql: SqlStorage,
  sessionId: string
): { allowed: boolean; reason?: string } {
  const sessionCount = getRateLimit(sql, "session", sessionId);
  if (sessionCount >= SELF_MODIFY_LIMIT_SESSION) {
    return { allowed: false, reason: "Session self-modification limit reached." };
  }

  const todayKey = new Date().toISOString().slice(0, 10);
  const dailyCount = getRateLimit(sql, "day", todayKey);
  if (dailyCount >= SELF_MODIFY_LIMIT_DAY) {
    return { allowed: false, reason: "Daily self-modification limit reached." };
  }

  return { allowed: true };
}

export function classifyCommand(command: string): CommandClassification {
  const normalized = command.trim();

  if (REQUIRES_APPROVAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "requires_approval";
  }

  if (AUTO_APPROVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "auto_approve";
  }

  if (CONDITIONAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "conditional";
  }

  return "conditional";
}

export function isSelfModificationCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  const hasWriteIntent = SELF_MOD_WRITE_PATTERNS.some((pattern) => pattern.test(normalized));
  if (!hasWriteIntent) {
    return false;
  }

  return SELF_MOD_TARGET_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function checkConstitution(command: string, files: string[]): string[] {
  const lowered = command.toLowerCase();

  return files.filter((file) => {
    if (!PROTECTED_FILES.includes(file as (typeof PROTECTED_FILES)[number])) {
      return false;
    }

    return /(rm|mv|cp|sed|tee|echo|cat|git\s+checkout|python|npm|touch)/.test(lowered);
  });
}

export function enforceSafety(
  command: string,
  sql: SqlStorage,
  sessionId: string,
  files: string[] = [],
  options: SafetyOptions = {}
): SafetyDecision {
  const { applySelfModificationRateLimit = true } = options;

  if (applySelfModificationRateLimit && isSelfModificationCommand(command)) {
    const rateLimit = checkRateLimit(sql, sessionId);
    if (!rateLimit.allowed) {
      return { allowed: false, reason: rateLimit.reason };
    }
  }

  const constitutionViolations = checkConstitution(command, files);
  if (constitutionViolations.length > 0) {
    return {
      allowed: false,
      reason: `Command attempts to modify protected files: ${constitutionViolations.join(", ")}`,
      requiresApproval: true
    };
  }

  const classification = classifyCommand(command);
  if (classification === "requires_approval") {
    return {
      allowed: false,
      reason: "Command requires human approval.",
      requiresApproval: true
    };
  }

  if (classification === "conditional") {
    return { allowed: true, requiresApproval: true };
  }

  return { allowed: true, requiresApproval: false };
}
