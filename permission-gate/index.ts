// Gates dangerous shell commands.
//
// Two layers:
//   1. a HARDLINE that nothing can switch off (wiping a filesystem or a home directory): blocked,
//      never asked, so no answer from anywhere can run it
//   2. the rest asks the user (the TUI, the phone, Telegram) and waits; KINOKO_YOLO=1 allows it
//
// The yolo flag deliberately does NOT reach the hardline: there is no way to make this file allow
// `rm -rf /`, on purpose.

import type { Kinoko, ToolCallAsk, ToolCallBlock } from "../api.ts";

const HARDLINE =
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME|\/\*|\/\.\*|\.\s*$|\/\s*$)|mkfs(\.\w+)?\s|:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:|>\s*\/dev\/sd[a-z]/i;

const GATED: Array<[string, RegExp]> = [
  ["rm -rf", /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i],
  ["sudo", /(^|[\s;&|])sudo\s/i],
  ["chmod 777", /\bchmod\s+(-[a-z]+\s+)*777\b/i],
  ["dd", /\bdd\s+if=/i],
  ["shutdown/reboot", /\b(shutdown|reboot|halt|poweroff)\b/i],
];

const yolo = process.env.KINOKO_YOLO === "1";

export default function (k: Kinoko): void {
  k.log(`permission-gate loaded (${yolo ? "yolo: gated commands allowed" : "asks before gated commands"})`);

  k.on("tool_call", (call) => {
    if (call.name !== "bash") return;
    // bash takes `command`; `cmd` is still accepted, so a gate must check both.
    const raw = call.args.command ?? call.args.cmd;
    const cmd = typeof raw === "string" ? raw : "";
    if (cmd === "") return;

    if (HARDLINE.test(cmd)) {
      return block(cmd, "hardline: this command is never allowed, not even with KINOKO_YOLO=1");
    }
    for (const [label, re] of GATED) {
      if (!re.test(cmd)) continue;
      if (yolo) return;
      return ask(`permission-gate: \`${label}\` needs your confirmation`);
    }
  });
}

function block(_cmd: string, reason: string): ToolCallBlock {
  return { block: true, reason: reason };
}

function ask(reason: string): ToolCallAsk {
  return { ask: true, reason: reason };
}