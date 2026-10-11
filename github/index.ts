// GitHub through the gh CLI (its login, its repository detection): pull requests, issues and CI
// runs, read in a shape a model can use; a failed run's log cut to the error (ci.ts). Writing
// (comments, new issues, new pull requests) is a separate tool, so read-only modes keep it out.

import type { Kinoko, ToolContext } from "../api.ts";
import { trimLog } from "./ci.ts";

/** About 4k tokens: a long thread or diff is cut, with a note. */
const MAX_CHARS = 16_000;
const BODY_CHARS = 1_500;

export type Gh = (args: string[], cwd: string, signal: AbortSignal) => Promise<{ code: number; out: string }>;

export const runGh: Gh = async (args, cwd, signal) => {
  try {
    const proc = Bun.spawn(["gh", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out: code === 0 ? out : (err.trim() || out).trim() };
  } catch {
    return { code: 127, out: "gh is not installed (https://cli.github.com)" };
  }
};

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const login = (v: unknown): string => str((v as Json | undefined)?.login) || "?";
const clip = (text: string, max = BODY_CHARS): string => {
  const t = text.replace(/\r/g, "").trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}… [${t.length - max} more chars]`;
};
const cap = (text: string): string => (text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n\n[cut at ${MAX_CHARS} of ${text.length} chars]`);
const day = (v: unknown): string => str(v).slice(0, 10);

/** The checks of a PR as one line: "✓ 5  ✗ 1 (lint)  … 2". */
function checks(rollup: unknown): string {
  if (!Array.isArray(rollup) || rollup.length === 0) return "no checks";
  const all = rollup as Json[];
  const state = (c: Json): string => str(c.conclusion || c.state || c.status).toUpperCase();
  const failed = all.filter((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(state(c)));
  const passed = all.filter((c) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state(c)));
  const pending = all.length - failed.length - passed.length;
  const names = failed.map((c) => str(c.name || c.context)).join(", ");
  return `✓ ${passed.length}${failed.length ? `  ✗ ${failed.length} (${names})` : ""}${pending ? `  … ${pending} running` : ""}`;
}

function thread(comments: unknown): string {
  if (!Array.isArray(comments) || comments.length === 0) return "";
  return `\n\n${comments.map((c: Json) => `— ${login(c.author)} ${day(c.createdAt)}${c.state ? ` [${str(c.state)}]` : ""}:\n${clip(str(c.body)) || "(no text)"}`).join("\n\n")}`;
}

async function json(gh: Gh, args: string[], ctx: ToolContext): Promise<unknown> {
  const res = await gh(args, ctx.cwd, ctx.signal);
  if (res.code !== 0) throw new Error(res.out);
  return JSON.parse(res.out) as unknown;
}

export async function read(args: Json, ctx: ToolContext, gh: Gh = runGh): Promise<string> {
  const repo = typeof args.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(args.repo) ? ["-R", args.repo] : [];
  const n = typeof args.number === "number" ? String(Math.trunc(args.number)) : str(args.number).replace(/^#/, "");
  const state = ["open", "closed", "merged", "all"].includes(str(args.state)) ? str(args.state) : "open";
  try {
    switch (args.action) {
      case "prs": {
        const prs = (await json(gh, ["pr", "list", ...repo, "--state", state, "--limit", "25", "--json", "number,title,author,headRefName,isDraft,reviewDecision,statusCheckRollup,updatedAt"], ctx)) as Json[];
        if (prs.length === 0) return `no ${state} pull requests`;
        return prs.map((p) => `#${str(p.number)} ${str(p.title)}${p.isDraft ? " (draft)" : ""}\n   ${login(p.author)} · ${str(p.headRefName)} · ${day(p.updatedAt)} · ${checks(p.statusCheckRollup)}${p.reviewDecision ? ` · ${str(p.reviewDecision).toLowerCase()}` : ""}`).join("\n");
      }
      case "pr": {
        if (!n) return "ERROR: github: pr needs a number";
        if (args.diff === true) {
          const res = await gh(["pr", "diff", n, ...repo, "--color", "never"], ctx.cwd, ctx.signal);
          return res.code === 0 ? cap(res.out) : `ERROR: github: ${res.out}`;
        }
        const p = (await json(gh, ["pr", "view", n, ...repo, "--json", "number,title,body,author,state,headRefName,baseRefName,additions,deletions,files,reviews,comments,statusCheckRollup,url,mergeable"], ctx)) as Json;
        const files = Array.isArray(p.files) ? (p.files as Json[]).map((f) => `  ${str(f.path)} +${str(f.additions)} -${str(f.deletions)}`).join("\n") : "";
        return cap(
          `#${str(p.number)} ${str(p.title)} [${str(p.state).toLowerCase()}${p.mergeable === "CONFLICTING" ? ", conflicts" : ""}]\n${str(p.url)}\n${login(p.author)} wants ${str(p.headRefName)} → ${str(p.baseRefName)}, +${str(p.additions)} -${str(p.deletions)}\nchecks: ${checks(p.statusCheckRollup)}\n\n${clip(str(p.body)) || "(no description)"}\n\nfiles:\n${files}${thread([...((p.reviews as Json[]) ?? []), ...((p.comments as Json[]) ?? [])])}\n\n(the diff: action pr with diff: true)`,
        );
      }
      case "issues": {
        const list = (await json(gh, ["issue", "list", ...repo, "--state", state === "merged" ? "closed" : state, "--limit", "30", "--json", "number,title,labels,author,updatedAt,comments"], ctx)) as Json[];
        if (list.length === 0) return `no ${state} issues`;
        return list.map((i) => `#${str(i.number)} ${str(i.title)}\n   ${login(i.author)} · ${day(i.updatedAt)} · ${Array.isArray(i.comments) ? i.comments.length : 0} comments${Array.isArray(i.labels) && i.labels.length ? ` · ${(i.labels as Json[]).map((l) => str(l.name)).join(", ")}` : ""}`).join("\n");
      }
      case "issue": {
        if (!n) return "ERROR: github: issue needs a number";
        const i = (await json(gh, ["issue", "view", n, ...repo, "--json", "number,title,body,author,state,labels,comments,url"], ctx)) as Json;
        return cap(`#${str(i.number)} ${str(i.title)} [${str(i.state).toLowerCase()}]\n${str(i.url)}\n${login(i.author)}\n\n${clip(str(i.body)) || "(no description)"}${thread(i.comments)}`);
      }
      case "ci": {
        if (n) {
          const run = (await json(gh, ["run", "view", n, ...repo, "--json", "displayTitle,workflowName,headBranch,status,conclusion,url,jobs"], ctx)) as Json;
          const jobs = Array.isArray(run.jobs) ? (run.jobs as Json[]).map((j) => `  ${str(j.conclusion || j.status)} · ${str(j.name)}`).join("\n") : "";
          const head = `${str(run.workflowName)}: ${str(run.displayTitle)} (${str(run.headBranch)}) — ${str(run.conclusion || run.status)}\n${str(run.url)}\n${jobs}`;
          if (run.conclusion !== "failure") return head;
          const log = await gh(["run", "view", n, ...repo, "--log-failed"], ctx.cwd, ctx.signal);
          return cap(`${head}\n\n${log.code === 0 ? trimLog(log.out) : `(no log: ${log.out})`}`);
        }
        // This directory's branch by default; another repository's runs on every branch.
        const branch = str(args.branch) || (repo.length > 0 ? "" : await currentBranch(ctx));
        const runs = (await json(gh, ["run", "list", ...repo, ...(branch ? ["--branch", branch] : []), "--limit", "10", "--json", "databaseId,workflowName,displayTitle,headBranch,status,conclusion,event,createdAt"], ctx)) as Json[];
        if (runs.length === 0) return `no CI runs${branch ? ` on ${branch}` : ""}`;
        const mark = (r: Json): string => (r.conclusion === "success" ? "✓" : r.conclusion === "failure" ? "✗" : r.status === "completed" ? "·" : "…");
        return `${runs.map((r) => `${mark(r)} ${str(r.databaseId)}  ${str(r.workflowName)}: ${str(r.displayTitle)} (${str(r.headBranch)}, ${str(r.event)}, ${day(r.createdAt)})`).join("\n")}\n\n(a failed run's log, cut to the error: action ci with its number)`;
      }
      default:
        return "ERROR: github: action is one of prs, pr, issues, issue, ci";
    }
  } catch (e) {
    return `ERROR: github: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function currentBranch(ctx: ToolContext): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "branch", "--show-current"], { cwd: ctx.cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore", signal: ctx.signal });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.trim() : "";
  } catch {
    return "";
  }
}

export async function write(args: Json, ctx: ToolContext, gh: Gh = runGh): Promise<string> {
  const repo = typeof args.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(args.repo) ? ["-R", args.repo] : [];
  const n = typeof args.number === "number" ? String(Math.trunc(args.number)) : str(args.number).replace(/^#/, "");
  const body = str(args.body);
  const title = str(args.title);
  let cmd: string[];
  if (args.action === "comment") {
    if (!n || !body) return "ERROR: github_write: comment needs number and body";
    cmd = ["issue", "comment", n, ...repo, "--body", body]; // works on pull requests too
  } else if (args.action === "create_issue") {
    if (!title) return "ERROR: github_write: create_issue needs a title";
    cmd = ["issue", "create", ...repo, "--title", title, "--body", body];
  } else if (args.action === "create_pr") {
    if (!title) return "ERROR: github_write: create_pr needs a title";
    cmd = ["pr", "create", ...repo, "--title", title, "--body", body, ...(str(args.base) ? ["--base", str(args.base)] : []), ...(args.draft === true ? ["--draft"] : [])];
  } else return "ERROR: github_write: action is one of comment, create_issue, create_pr";
  const res = await gh(cmd, ctx.cwd, ctx.signal);
  return res.code === 0 ? `done: ${res.out.trim()}` : `ERROR: github_write: ${res.out}`;
}

export default function (k: Kinoko): void {
  k.registerTool({
    name: "github",
    description:
      "Read GitHub through gh: pull requests (list, one with its checks, reviews and files, or its diff), issues (list, one with its comments) and CI runs (the branch's recent runs; one run by number: its jobs and, when it failed, the log cut to the error). The repository is the one in the working directory unless repo is given.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["prs", "pr", "issues", "issue", "ci"] },
        number: { type: "number", description: "the PR, issue or run number" },
        diff: { type: "boolean", description: "pr: the diff instead of the summary" },
        state: { type: "string", enum: ["open", "closed", "merged", "all"], description: "prs/issues: which ones (default open)" },
        branch: { type: "string", description: "ci: the branch (default the current one)" },
        repo: { type: "string", description: "owner/name (default: this directory's repository)" },
      },
      required: ["action"],
    },
    readOnly: true,
    run: async (args: Json, ctx: ToolContext) => read(args, ctx),
  });

  k.registerTool({
    name: "github_write",
    description: "Write to GitHub through gh: comment on an issue or pull request, open an issue, or open a pull request from the current branch (pushed first).",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["comment", "create_issue", "create_pr"] },
        number: { type: "number", description: "comment: the issue or PR number" },
        title: { type: "string" },
        body: { type: "string", description: "markdown" },
        base: { type: "string", description: "create_pr: the branch to merge into (default the repository's default)" },
        draft: { type: "boolean", description: "create_pr: as a draft" },
        repo: { type: "string", description: "owner/name (default: this directory's repository)" },
      },
      required: ["action"],
    },
    run: async (args: Json, ctx: ToolContext) => write(args, ctx),
  });
}
