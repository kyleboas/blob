import type { RemediationScopePolicy } from "../config/policy";

export interface PatchFileChange {
  path: string;
  addedLines: number;
  removedLines: number;
}

export interface PatchPlan {
  files: PatchFileChange[];
}

export interface PatchSafetyResult {
  safe: boolean;
  reason?: string;
}

export function evaluatePatchSafety(
  patch: PatchPlan,
  policy: RemediationScopePolicy
): PatchSafetyResult {
  if (patch.files.length === 0) {
    return { safe: false, reason: "Patch plan contains no file changes" };
  }

  if (patch.files.length > policy.maxFilesChanged) {
    return { safe: false, reason: "Patch exceeds max files changed" };
  }

  const totalChangedLines = patch.files.reduce(
    (total, file) => total + file.addedLines + file.removedLines,
    0
  );

  if (totalChangedLines > policy.maxLinesChanged) {
    return { safe: false, reason: "Patch exceeds max lines changed" };
  }

  for (const file of patch.files) {
    if (!policy.allowDependencyChanges && file.path === "package.json") {
      return { safe: false, reason: "Dependency changes are disabled by policy" };
    }

    if (policy.deniedPathPrefixes.some((prefix) => file.path.startsWith(prefix))) {
      return { safe: false, reason: `Denied path prefix matched: ${file.path}` };
    }

    const inAllowedPath = policy.allowedPathPrefixes.some((prefix) => file.path.startsWith(prefix));
    if (!inAllowedPath) {
      return { safe: false, reason: `File outside allowed paths: ${file.path}` };
    }
  }

  return { safe: true };
}
