import { describe, expect, test } from "bun:test";
import { Bus } from "../testing/bus.ts";
import install from "./index.ts";

/** What the gate does with a call: "block: <reason>", "ask: <reason>", or undefined when it allows it. */
function blocker(): (name: string, args: Record<string, unknown>) => string | undefined {
  const bus = new Bus();
  install(bus);
  return (name, args) => {
    const decision = bus.beforeTool({ name, args, signal: new AbortController().signal });
    return decision === undefined ? undefined : `${"block" in decision ? "block" : "ask"}: ${decision.reason}`;
  };
}

describe("permission-gate", () => {
  test("hardline always blocked; gated commands ask unless yolo is set", () => {
    const blocked = blocker();
    expect(blocked("bash", { cmd: "rm -rf /" })).toStartWith("block: hardline");
    expect(blocked("bash", { cmd: "rm -rf ~/" })).toStartWith("block: hardline");
    expect(blocked("bash", { cmd: "rm -rf / --no-preserve-root" })).toContain("hardline");
    expect(blocked("bash", { cmd: "sudo rm x" })).toBe("ask: permission-gate: `sudo` needs your confirmation");
    expect(blocked("bash", { cmd: "chmod 777 /tmp/x" })).toStartWith("ask: permission-gate");
    expect(blocked("bash", { cmd: "ls -la" })).toBeUndefined();
    expect(blocked("bash", { command: "rm -rf /" })).toContain("hardline");
    expect(blocked("read", { path: "a.txt" })).toBeUndefined();
  });

  test("the hardline is the root, the home or the folder itself, not any absolute path", () => {
    const blocked = blocker();
    for (const cmd of ["rm -rf /*", "rm -rf ~", "rm -rf $HOME", 'rm -rf "$HOME"/', "rm -rf .", "rm -r -f /", "rm -rf -- /", "rm -rf build /", "cd x && rm -rf . && ls"]) {
      expect(blocked("bash", { cmd })).toStartWith("block: hardline");
    }
    // A watcher script from a real session: its `rm -f /tmp/...` was refused as if it were `rm -rf /`.
    const script = "while true; do\n  if [ -f /tmp/changed.txt ]; then\n    rm -f /tmp/changed.txt\n  fi\n  sleep 5\ndone";
    for (const cmd of ["rm -f /tmp/x", "rm -rf ~/build", "rm -rf $HOME/.cache/x", "rm -rf ./dist", "rm -f /tmp/a /tmp/b", script]) {
      expect(blocked("bash", { cmd })).toBe("ask: permission-gate: `rm -rf` needs your confirmation");
    }
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
