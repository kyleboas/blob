import { describe, expect, it } from "vitest";
import { SELF_MODIFY_LIMIT_DAY, SELF_MODIFY_LIMIT_SESSION } from "./config";
import {
  checkConstitution,
  checkRateLimit,
  classifyCommand,
  enforceSafety,
  isSelfModificationCommand
} from "./safety";
import { incrementRateLimit, type SqlStorage } from "./storage";

class FakeSql implements SqlStorage {
  private rateLimits = new Map<string, number>();

  exec(query: string, ...bindings: Array<string | number | null>) {
    const normalized = query.trim().replace(/\s+/g, " ");
    if (normalized.startsWith("INSERT INTO rate_limits")) {
      const key = `${bindings[0]}:${bindings[1]}`;
      const count = this.rateLimits.get(key) ?? 0;
      this.rateLimits.set(key, count + 1);
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT count FROM rate_limits")) {
      const key = `${bindings[0]}:${bindings[1]}`;
      const count = this.rateLimits.get(key);
      return { toArray: () => (count === undefined ? [] : [{ count }]) };
    }

    return { toArray: () => [] };
  }
}

describe("checkRateLimit", () => {
  it("allows when under limits", () => {
    const sql = new FakeSql();
    expect(checkRateLimit(sql, "session-1")).toEqual({ allowed: true });
  });

  it("blocks when session limit is reached", () => {
    const sql = new FakeSql();
    for (let i = 0; i < SELF_MODIFY_LIMIT_SESSION; i += 1) {
      incrementRateLimit(sql, "session", "session-1");
    }

    const result = checkRateLimit(sql, "session-1");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Session");
  });

  it("blocks when daily limit is reached", () => {
    const sql = new FakeSql();
    const todayKey = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < SELF_MODIFY_LIMIT_DAY; i += 1) {
      incrementRateLimit(sql, "day", todayKey);
    }

    const result = checkRateLimit(sql, "session-2");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Daily");
  });
});

describe("classifyCommand", () => {
  it("classifies read-only as auto approve", () => {
    expect(classifyCommand("git status")).toBe("auto_approve");
  });

  it("classifies workspace writes as conditional", () => {
    expect(classifyCommand("git commit -m 'x'")).toBe("conditional");
  });

  it("classifies destructive commands as requires approval", () => {
    expect(classifyCommand("rm -rf tmp")).toBe("requires_approval");
  });
});



describe("isSelfModificationCommand", () => {
  it("returns false for read-only commands", () => {
    expect(isSelfModificationCommand("cat README.md")).toBe(false);
  });

  it("returns true for source-modifying commands", () => {
    expect(isSelfModificationCommand("sed -i 's/a/b/' src/agent.ts")).toBe(true);
  });
});

describe("checkConstitution", () => {
  it("detects protected files", () => {
    const violations = checkConstitution("sed -i 's/x/y/' safety.py", ["safety.py", "README.md"]);
    expect(violations).toEqual(["safety.py"]);
  });
});

describe("enforceSafety", () => {
  it("auto approves safe read commands", () => {
    const sql = new FakeSql();
    const decision = enforceSafety("cat README.md", sql, "session-1", ["README.md"]);
    expect(decision).toEqual({ allowed: true, requiresApproval: false });
  });

  it("requires approval for conditional commands", () => {
    const sql = new FakeSql();
    const decision = enforceSafety("git commit -m 'update'", sql, "session-2", ["src/index.ts"]);
    expect(decision).toEqual({ allowed: true, requiresApproval: true });
  });



  it("does not apply self-modification limits to non-modifying commands", () => {
    const sql = new FakeSql();
    for (let i = 0; i < SELF_MODIFY_LIMIT_SESSION; i += 1) {
      incrementRateLimit(sql, "session", "session-4");
    }

    const decision = enforceSafety("cat README.md", sql, "session-4", ["README.md"]);
    expect(decision).toEqual({ allowed: true, requiresApproval: false });
  });


  it("can skip self-modification limits for user-directed sessions", () => {
    const sql = new FakeSql();
    for (let i = 0; i < SELF_MODIFY_LIMIT_SESSION; i += 1) {
      incrementRateLimit(sql, "session", "session-6");
    }

    const decision = enforceSafety("sed -i 's/a/b/' src/safety.ts", sql, "session-6", ["src/safety.ts"], {
      applySelfModificationRateLimit: false
    });
    expect(decision).toEqual({ allowed: true, requiresApproval: true });
  });
  it("applies self-modification limits only to modifying commands", () => {
    const sql = new FakeSql();
    for (let i = 0; i < SELF_MODIFY_LIMIT_SESSION; i += 1) {
      incrementRateLimit(sql, "session", "session-5");
    }

    const decision = enforceSafety("sed -i 's/a/b/' src/safety.ts", sql, "session-5", ["src/safety.ts"]);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Session");
  });


  it("blocks .netrc writes", () => {
    const sql = new FakeSql();
    const decision = enforceSafety("echo token > ~/.netrc", sql, "session-netrc");
    expect(decision).toEqual(expect.objectContaining({ allowed: false, requiresApproval: false }));
  });

  it("blocks gh usage", () => {
    const sql = new FakeSql();
    const decision = enforceSafety("gh pr create --title x", sql, "session-gh");
    expect(decision).toEqual(expect.objectContaining({ allowed: false, requiresApproval: false }));
  });

  it("blocks direct pushes to main", () => {
    const sql = new FakeSql();
    const decision = enforceSafety("git push origin main", sql, "session-main");
    expect(decision).toEqual(expect.objectContaining({ allowed: false, requiresApproval: false }));
  });

  it("blocks protected file modifications", () => {
    const sql = new FakeSql();
    const decision = enforceSafety("sed -i 's/x/y/' safety.py", sql, "session-3", ["safety.py"]);
    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
  });
});
