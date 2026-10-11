// Telegram: a `telegram_send` tool, so the model can send you a file in the chat paired from
// kinoko's /integrations ("send me the PDF on Telegram"). It reads ~/.kinoko/integrations.json and
// calls the Bot API itself (sendDocument: the file as it is, not recompressed), so it works from a
// terminal too, with or without `kinoko serve`. The token never shows in a result or a log.

import { stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Kinoko, ToolContext } from "../api.ts";

/** Telegram takes files up to this size from a bot. */
export const UPLOAD_MAX = 50 * 1024 * 1024;

export interface Options {
  home?: string;
  /** Telegram's address (a fake one in tests). */
  apiBase?: string;
}

interface Paired {
  token: string;
  chat: number;
}

async function paired(home: string): Promise<Paired | undefined> {
  try {
    const data = (await Bun.file(join(home, ".kinoko", "integrations.json")).json()) as { telegram?: { token?: unknown; chat?: unknown } };
    const t = data.telegram;
    return typeof t?.token === "string" && typeof t.chat === "number" ? { token: t.token, chat: t.chat } : undefined;
  } catch {
    return undefined;
  }
}

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function install(k: Kinoko, opts: Options = {}): void {
  const home = opts.home ?? process.env.HOME ?? "";
  const base = opts.apiBase ?? "https://api.telegram.org";
  k.registerTool({
    name: "telegram_send",
    description: "Send the user a file through Telegram (the chat paired in kinoko's /integrations), when they ask to get it there. Up to 50 MB; a folder must be zipped first.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "the file to send" },
        caption: { type: "string", description: "a short note that goes with it" },
      },
      required: ["path"],
    },
    readOnly: true,
    run: async (args: { path?: unknown; caption?: unknown }, ctx: ToolContext) => {
      if (typeof args.path !== "string" || args.path.trim() === "") return "ERROR: telegram_send: missing path (string)";
      const path = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined) return `ERROR: telegram_send: no file ${path}`;
      if (info.isDirectory()) return `ERROR: telegram_send: ${path} is a folder: zip it first (zip -r)`;
      if (info.size > UPLOAD_MAX) return `ERROR: telegram_send: ${sizeText(info.size)} is more than Telegram takes from a bot (50 MB)`;
      const bot = await paired(home);
      if (bot === undefined) return "ERROR: telegram_send: Telegram is not set up: the user pairs it in kinoko with /integrations";
      const form = new FormData();
      form.append("chat_id", String(bot.chat));
      form.append("document", Bun.file(path), basename(path));
      if (typeof args.caption === "string" && args.caption.trim()) form.append("caption", args.caption.trim().slice(0, 1024));
      try {
        const res = await fetch(`${base}/bot${bot.token}/sendDocument`, { method: "POST", body: form, signal: ctx.signal });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
        if (!res.ok || data.ok !== true) return `ERROR: telegram_send: Telegram refused it: ${(data.description ?? `HTTP ${res.status}`).split(bot.token).join("<token>")}`;
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        return `ERROR: telegram_send: could not reach Telegram: ${(e instanceof Error ? e.message : String(e)).split(bot.token).join("<token>")}`;
      }
      return `sent ${basename(path)} (${sizeText(info.size)}) to Telegram`;
    },
  });
}

export default function (k: Kinoko): void {
  install(k);
}
