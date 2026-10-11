// A failed CI run's log, cut down to what explains the failure. `gh run view --log-failed` sends
// every line of every failed job (the runner's setup, the checkout, hundreds of lines before the
// error); this keeps, per job, the error lines with the lines that lead up to them.

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const STAMP = /^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
/** A line that says something failed. */
const FAILURE = /##\[error\]|\berror\b|\bfail(ed|ure|s)?\b|panic:|exception|traceback|✗|✘|\bassert|expected .* (got|received)|exit code [1-9]/i;
/** Lines kept before an error line: the command and what it printed. */
const BEFORE = 25;
const AFTER = 5;
/** Per job, at most this many lines; the end of the job when no line says error. */
const PER_JOB = 160;
const TAIL = 60;

interface Line {
  job: string;
  step: string;
  text: string;
}

function parse(log: string): Line[] {
  const out: Line[] = [];
  for (const raw of log.split("\n")) {
    const [job = "", step = "", ...rest] = raw.split("\t");
    if (rest.length === 0) continue;
    out.push({ job, step, text: rest.join("\t").replace(STAMP, "").replace(ANSI, "").trimEnd() });
  }
  return out;
}

/** The runner's own grouped output (setup, environment dumps): never the failure. */
function noise(lines: Line[]): boolean[] {
  const skip: boolean[] = [];
  let depth = 0;
  for (const line of lines) {
    if (line.text.startsWith("##[group]")) depth++;
    skip.push(depth > 0);
    if (line.text.startsWith("##[endgroup]")) depth = Math.max(0, depth - 1);
  }
  return skip;
}

export function trimLog(log: string): string {
  const lines = parse(log);
  if (lines.length === 0) return log.trim() === "" ? "(no failed log: the run may still be going, or it failed before any step)" : log.trim();
  const jobs = [...new Set(lines.map((l) => l.job))];
  const sections: string[] = [];
  for (const job of jobs) {
    // After "Process completed with exit code N" comes the runner's cleanup: nothing to read there.
    const all = lines.filter((l) => l.job === job);
    const exit = all.findLastIndex((l) => /Process completed with exit code/.test(l.text));
    const mine = exit >= 0 ? all.slice(0, exit + 1) : all;
    const skip = noise(mine);
    const keep = new Set<number>();
    mine.forEach((line, i) => {
      if (skip[i] || !FAILURE.test(line.text)) return;
      for (let j = Math.max(0, i - BEFORE); j <= Math.min(mine.length - 1, i + AFTER); j++) if (!skip[j]) keep.add(j);
    });
    if (keep.size === 0) for (let j = Math.max(0, mine.length - TAIL); j < mine.length; j++) keep.add(j);
    const picked = [...keep].toSorted((a, b) => a - b).slice(-PER_JOB);
    const rows: string[] = [];
    let step = "";
    let last = -2;
    for (const i of picked) {
      const line = mine[i];
      if (!line) continue;
      if (line.step !== step) {
        step = line.step;
        rows.push(`── ${step}`);
      } else if (i !== last + 1) rows.push("   …");
      rows.push(line.text.replace(/^##\[error\]/, "ERROR "));
      last = i;
    }
    const cut = keep.size > PER_JOB ? ` (last ${PER_JOB} of ${keep.size} relevant lines)` : "";
    sections.push(`## ${job}${cut}\n${rows.join("\n")}`);
  }
  return sections.join("\n\n");
}
