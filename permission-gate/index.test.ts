import { describe, expect, test } from "bun:test";
import { Bus } from "../testing/bus.ts";
import install from "./index.ts";

/** The reason the gate blocks a call, or undefined when it allows it. */
function blocker(): (name: string, args: Record<string, unknown>) => string | undefined {
  const bus = new Bus();
  install(bus);
  return (name, args) => bus.beforeTool({ name, args, signal: new AbortController().signal })?.reason;
}

describe("permission-gate", () => {
  test("hardline always; gated commands denied unless yolo is set", () => {
    const blocked = blocker();
    expect(blocked("bash", { cmd: "rm -rf /" })).toContain("hardline");
    expect(blocked("bash", { cmd: "rm -rf ~/" })).toContain("hardline");
    expect(blocked("bash", { cmd: "rm -rf / --no-preserve-root" })).toContain("hardline");
    expect(blocked("bash", { cmd: "sudo rm x" })).toContain("denied by permission-gate");
    expect(blocked("bash", { cmd: "chmod 777 /tmp/x" })).toContain("denied by permission-gate");
    expect(blocked("bash", { cmd: "ls -la" })).toBeUndefined();
    expect(blocked("bash", { command: "rm -rf /" })).toContain("hardline");
    expect(blocked("read", { path: "a.txt" })).toBeUndefined();
  });

  test("KINOKO_YOLO=1 opens the gate, never the hardline", async () => {
    process.env.KINOKO_YOLO = "1";
    try {
      // The flag is read when the module loads: a fresh copy of it.
      const fresh = (await import(`${import.meta.dir}/index.ts?yolo`)) as { default: typeof install };
      const bus = new Bus();
      fresh.default(bus);
      const yolo = (cmd: string): string | undefined => bus.beforeTool({ name: "bash", args: { cmd }, signal: new AbortController().signal })?.reason;
      expect(yolo("sudo rm x")).toBeUndefined();
      expect(yolo("chmod 777 /tmp/x")).toBeUndefined();
      expect(yolo("rm -rf /")).toContain("hardline");
    } finally {
      delete process.env.KINOKO_YOLO;
    }
  });
});
