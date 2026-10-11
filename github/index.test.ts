import { describe, expect, test } from "bun:test";
import type { Tool } from "../api.ts";
import { Bus } from "../testing/bus.ts";
import { trimLog } from "./ci.ts";
import install, { read, write } from "./index.ts";
import type { Gh } from "./index.ts";

const ctx = { signal: new AbortController().signal, cwd: "/repo" };

/** A gh that answers from a table, keyed by its first words; it records every call. */
function fake(answers: Record<string, unknown>): { gh: Gh; calls: string[][] } {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
    if (key === undefined) return { code: 1, out: `unknown: ${args.join(" ")}` };
    const value = answers[key];
    return { code: 0, out: typeof value === "string" ? value : JSON.stringify(value) };
  };
  return { gh, calls };
}

const log = [
  "test\tSet up job\t2026-10-09T19:39:50.1Z ##[group]Runner Image",
  "test\tSet up job\t2026-10-09T19:39:50.2Z noise inside a group",
  "test\tSet up job\t2026-10-09T19:39:50.3Z ##[endgroup]",
  ...Array.from({ length: 60 }, (_, i) => `test\tRun tests\t2026-10-09T19:40:00.0Z line ${i}`),
  "test\tRun tests\t2026-10-09T19:40:01.0Z FAIL src/x.test.ts > adds",
  "test\tRun tests\t2026-10-09T19:40:01.1Z ##[error]Process completed with exit code 1.",
  "test\tPost Checkout\t2026-10-09T19:40:02.0Z cleanup error that does not matter",
].join("\n");

describe("github: CI logs", () => {
  test("a failed log keeps the error and what led to it; setup groups and post-run cleanup go", () => {
    const out = trimLog(log);
    expect(out).toStartWith("## test\n── Run tests\n");
    expect(out).toContain("FAIL src/x.test.ts > adds");
    expect(out).toEndWith("ERROR Process completed with exit code 1.");
    expect(out).toContain("line 59");
    expect(out).not.toContain("line 10\n"); // more than 25 lines before the error
    for (const gone of ["noise inside a group", "cleanup error", "2026-10-09T"]) expect(out).not.toContain(gone);
  });

  test("no failure line: the end of the job", () => {
    const quiet = Array.from({ length: 100 }, (_, i) => `job\tstep\tline ${i}`).join("\n");
    expect(trimLog(quiet)).toContain("line 99");
    expect(trimLog(quiet)).not.toContain("line 10\n");
  });
});

describe("github tool", () => {
  test("registers github (read-only) and github_write", () => {
    const bus = new Bus();
    install(bus);
    expect(bus.tools().map((t: Tool) => [t.name, t.readOnly ?? false])).toEqual([["github", true], ["github_write", false]]);
  });

  test("prs: one line each with its checks and review", async () => {
    const { gh } = fake({
      "pr list": [{ number: 7, title: "Fix it", author: { login: "ana" }, headRefName: "fix/it", isDraft: false, reviewDecision: "APPROVED", updatedAt: "2026-10-09T10:00:00Z", statusCheckRollup: [{ name: "lint", conclusion: "FAILURE" }, { name: "test", conclusion: "SUCCESS" }, { name: "e2e", status: "IN_PROGRESS" }] }],
    });
    expect(await read({ action: "prs" }, ctx, gh)).toBe("#7 Fix it\n   ana · fix/it · 2026-10-09 · ✓ 1  ✗ 1 (lint)  … 1 running · approved");
  });

  test("pr: summary with files and the thread; diff on request; another repository with -R", async () => {
    const { gh, calls } = fake({
      "pr view": { number: 7, title: "Fix it", body: "Because.", author: { login: "ana" }, state: "OPEN", headRefName: "fix/it", baseRefName: "main", additions: 3, deletions: 1, files: [{ path: "a.ts", additions: 3, deletions: 1 }], reviews: [{ author: { login: "bo" }, state: "CHANGES_REQUESTED", body: "nope" }], comments: [], statusCheckRollup: [], url: "https://x/7" },
      "pr diff": "diff --git a/a.ts b/a.ts",
    });
    const out = await read({ action: "pr", number: 7, repo: "o/r" }, ctx, gh);
    expect(out).toContain("ana wants fix/it → main, +3 -1");
    expect(out).toContain("  a.ts +3 -1");
    expect(out).toContain("— bo  [CHANGES_REQUESTED]:\nnope");
    expect(calls[0]).toContain("-R");
    expect(await read({ action: "pr", number: 7, diff: true }, ctx, gh)).toBe("diff --git a/a.ts b/a.ts");
  });

  test("ci: a failed run shows its jobs and the trimmed log", async () => {
    const { gh } = fake({
      "run view 99 --json": { displayTitle: "Fix it", workflowName: "CI", headBranch: "fix/it", status: "completed", conclusion: "failure", url: "https://x/run", jobs: [{ name: "test", conclusion: "failure" }] },
      "run view 99 --log-failed": log,
    });
    const out = await read({ action: "ci", number: 99 }, ctx, gh);
    expect(out).toStartWith("CI: Fix it (fix/it) — failure\nhttps://x/run\n  failure · test\n\n## test");
    expect(out).toContain("FAIL src/x.test.ts");
  });

  test("errors from gh come back as tool errors", async () => {
    const { gh } = fake({});
    expect(await read({ action: "issues" }, ctx, gh)).toStartWith("ERROR: github: unknown: issue list");
    expect(await read({ action: "pr" }, ctx, gh)).toBe("ERROR: github: pr needs a number");
    expect(await read({ action: "nope" }, ctx, gh)).toStartWith("ERROR: github: action is one of");
  });

  test("write: a comment, an issue, a pull request; missing fields are errors", async () => {
    const { gh, calls } = fake({ "issue comment": "https://x/7#c", "issue create": "https://x/8", "pr create": "https://x/9" });
    expect(await write({ action: "comment", number: 7, body: "hi" }, ctx, gh)).toBe("done: https://x/7#c");
    expect(await write({ action: "create_pr", title: "T", body: "B", base: "main", draft: true }, ctx, gh)).toBe("done: https://x/9");
    expect(calls[1]).toEqual(["pr", "create", "--title", "T", "--body", "B", "--base", "main", "--draft"]);
    expect(await write({ action: "comment", number: 7 }, ctx, gh)).toStartWith("ERROR:");
  });
});
