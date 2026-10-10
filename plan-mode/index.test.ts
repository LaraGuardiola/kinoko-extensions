import { describe, expect, test } from "bun:test";
import { Bus } from "../testing/bus.ts";
import install from "./index.ts";

describe("plan-mode", () => {
  test("blocks write and edit and mutating bash, allows reads", () => {
    const bus = new Bus();
    install(bus);
    const reason = (name: string, args: Record<string, unknown>): string | undefined =>
      bus.beforeTool({ name, args, signal: new AbortController().signal })?.reason;
    expect(reason("write", { path: "a.txt", content: "x" })).toContain("plan mode is read-only");
    expect(reason("edit", { path: "a.txt" })).toContain("plan mode is read-only");
    expect(reason("bash", { cmd: "git status" })).toBeUndefined();
    expect(reason("bash", { cmd: "ls -la\nrg needle src" })).toBeUndefined();
    expect(reason("bash", { cmd: "npm install" })).toContain("plan mode");
    expect(reason("bash", { cmd: "ls -la && rm x" })).toContain("plan mode");
    expect(reason("bash", { cmd: "cat a.txt > b.txt" })).toContain("plan mode");
    expect(reason("bash", { command: "npm install" })).toContain("plan mode");
    expect(reason("read", { path: "a.txt" })).toBeUndefined();
  });
});
