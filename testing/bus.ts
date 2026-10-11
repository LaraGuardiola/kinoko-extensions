// A stand-in for kinoko's extension host, for the tests: the same calls an extension makes
// (on, registerTool, registerCommand, registerRenderer, log) and the same way kinoko fires events back. Handlers
// that throw are skipped, as in kinoko.

import type { CommandHandler, ExtEvent, ExtHandlers, FenceRenderer, Kinoko, Tool, ToolCallAsk, ToolCallBlock, ToolCallDecision, ToolCallEvent } from "../api.ts";

type AnyHandler = (arg: never) => unknown;

export class Bus implements Kinoko {
  #handlers = new Map<ExtEvent, AnyHandler[]>();
  #tools: Tool[] = [];
  #commands = new Map<string, CommandHandler>();
  #renderers = new Map<string, FenceRenderer>();
  logs: string[] = [];

  on<E extends ExtEvent>(event: E, handler: ExtHandlers[E]): void {
    this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), handler as AnyHandler]);
  }

  registerTool(tool: Tool): void {
    this.#tools.push(tool);
  }

  registerCommand(name: string, handler: CommandHandler): void {
    this.#commands.set(name, handler);
  }

  registerRenderer(lang: string, render: FenceRenderer): void {
    this.#renderers.set(lang, render);
  }

  renderer(lang: string): FenceRenderer | undefined {
    return this.#renderers.get(lang);
  }

  log(message: string): void {
    this.logs.push(message);
  }

  tools(): Tool[] {
    return [...this.#tools];
  }

  command(name: string): CommandHandler | undefined {
    return this.#commands.get(name);
  }

  emit<E extends ExtEvent>(event: E, payload: Parameters<ExtHandlers[E]>[0]): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      try {
        (handler as (arg: unknown) => unknown)(payload);
      } catch {
        // a broken handler never breaks the run
      }
    }
  }

  /** tool_call: the first handler that blocks wins. */
  /** The first block wins, even over an earlier ask, as in kinoko. */
  beforeTool(call: ToolCallEvent): ToolCallDecision | undefined {
    let ask: ToolCallAsk | undefined;
    for (const handler of this.#handlers.get("tool_call") ?? []) {
      try {
        const decision = (handler as (c: ToolCallEvent) => unknown)(call);
        if (typeof decision !== "object" || decision === null) continue;
        if ((decision as ToolCallBlock).block === true) return decision as ToolCallBlock;
        if (ask === undefined && (decision as ToolCallAsk).ask === true) ask = decision as ToolCallAsk;
      } catch {
        // skipped, as in kinoko
      }
    }
    return ask;
  }
}
