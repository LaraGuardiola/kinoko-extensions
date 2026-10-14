// The extension API, as kinoko defines it (src/ext.ts, src/types.ts in the kinoko repo), copied
// here so this repo stands alone. Extensions import from it with `import type` only: the types
// vanish at runtime, so an installed extension (~/.kinoko/ext/<name>/index.ts) never needs this
// file. When kinoko's API changes, change this file in the same way.

export type Role = "system" | "user" | "assistant" | "tool";
export type StopReason = "end" | "tool_use" | "length" | "aborted" | "error";

export interface SessionStartInfo {
  cwd: string;
  model: string;
  mode: "tui" | "print" | "rpc";
}

export interface ToolCallEvent {
  name: string;
  args: Record<string, unknown>; // mutate in place to change what the tool receives
  signal: AbortSignal;
}

export interface ToolCallBlock {
  block: true;
  reason: string; // becomes the tool result the model sees
}

/** Asks the user before the call runs (the loop waits for the answer); a deny is the tool's result. */
export interface ToolCallAsk {
  ask: true;
  reason: string; // shown to the user with the call
}

export type ToolCallDecision = ToolCallBlock | ToolCallAsk;

export interface ToolResultEvent {
  name: string;
  output: string; // mutate in place to rewrite what the model sees
  signal: AbortSignal;
}

export interface CompactInfo {
  before: number;
  after: number;
}

export interface ExtHandlers {
  session_start: (info: SessionStartInfo) => void;
  context: (messages: Message[]) => Message[]; // rewrite the history before a provider call
  before_provider_request: (req: ProviderRequest) => void;
  tool_call: (call: ToolCallEvent) => ToolCallDecision | void;
  tool_result: (result: ToolResultEvent) => void;
  turn_end: (message: Message) => void;
  compact: (info: CompactInfo) => void;
  run_end: (result: RunResult) => void;
  /** Everything the agent tells its clients (AgentEvent below), as it happens: read-only. */
  agent_event: (event: AgentEvent) => void;
  /** The user asked for quiet: Esc or Ctrl-C in the TUI, with a run going or not. */
  interrupt: () => void;
}

export type ExtEvent = keyof ExtHandlers;
export type CommandHandler = (args: string) => string | Promise<string>;
export type ExtensionFactory = (k: Kinoko) => void | Promise<void>;
/** Draws a fenced block of its language (```mermaid) in the transcript: the rows, each at most
 *  `width` columns, or undefined to show the source as code. Called with whole blocks only. */
export type FenceRenderer = (source: string, width: number) => string[] | undefined;
/** The keys an extension may take: ones the TUI leaves free. */
export type ExtKey = "ctrl-space";
export type KeyHandler = () => void | Promise<void>;
/** A prompt (when idle, a steer otherwise), or a steer delivered now, cutting the reply being streamed. */
export type SendAs = "prompt" | "steer_now";

export interface Kinoko {
  on<E extends ExtEvent>(event: E, handler: ExtHandlers[E]): void;
  registerTool(tool: Tool): void;
  /** `/name args` in the TUI (listed in its slash menu with `description`), and `kinoko /name args`. */
  registerCommand(name: string, handler: CommandHandler, description?: string): void;
  registerRenderer(lang: string, render: FenceRenderer): void;
  /** A key in the TUI (listed in /help with `description`). */
  registerKey(key: ExtKey, handler: KeyHandler, description?: string): void;
  /** Sends `text` as if the user typed it and pressed Enter (or Alt+X, for "steer_now"). False
   *  where nobody types: print and rpc modes. */
  send(text: string, opts?: { as?: SendAs }): boolean;
  /** A short line in the TUI's status bar ("● listening"); undefined takes it away. */
  status(text: string | undefined): void;
  log(message: string): void;
}

export type RunResult = { reason: "done" | "aborted" | "error" | "limit"; dropped?: string[]; detail?: string };

/** What the agent tells its clients (kinoko's src/agent-events.ts), in the order a run produces them. */
export type AgentEvent =
  | { type: "run_start"; prompt: string }
  | { type: "request_start"; at: number; model: string; messages: number; tools: number; chars: number; tokens: number }
  | { type: "prefill"; done: number; total: number }
  | { type: "first_token"; at: number }
  | { type: "message_delta"; delta: string } // the reply's text, as it streams
  | { type: "thinking_delta"; delta: string }
  | { type: "message_end"; message: Message }
  | { type: "tool_pending"; name: string; args?: Record<string, string>; index?: number }
  | { type: "tool_start"; call: ToolCall }
  | { type: "gate"; call: ToolCall; decision: "pass" | "block" | "ask"; by?: string; reason?: string; rewritten?: boolean; skipped?: "auto" | "remembered" }
  | { type: "tool_output"; call: ToolCall; output: string }
  | { type: "tool_end"; call: ToolCall }
  | { type: "appended"; role: Role; kind: "prompt" | "steer" | "follow_up" | "reply" | "result" | "note" | "nudge"; chars: number; text?: string }
  | { type: "guard"; what: "repeat" | "empty" | "length" | "same_call" | "same_error" | "unknown_tool"; detail: string }
  | { type: "queue_change"; steer: string[]; followUp: string[] }
  | { type: "delivered"; text: string }
  | { type: "compacting"; phase: "reading" | "writing"; done: number; total?: number }
  | { type: "compacted"; keep: number }
  | { type: "approval_request"; id: string; call: ToolCall; reason: string }
  | { type: "approval_end"; id: string; allow: boolean; by: "tui" | "app" | "telegram" | "timeout" | "abort" }
  | { type: "jobs"; running: number }
  | { type: "model"; model: string }
  | { type: "retry"; attempt: number; of: number; inMs: number; error: string }
  | { type: "run_end"; reason: "done" | "aborted" | "error" | "limit"; dropped?: string[]; detail?: string };

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

export interface Image {
  mime: string;
  data: string;
}

export interface Message {
  id: string;
  parentId?: string;
  role: Role;
  content: string;
  // Shown, logged, and sent back where the wire has a field for it (openai-compat `reasoning_content`:
  // chat templates that preserve thinking render it into the prompt). Anthropic uses `replay` instead.
  thinking?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string; // toolCallId only on role "tool"
  images?: Image[]; // role "user" (the text refers to them as [Image #N]) or "tool" (a vision tool's result)
  stop?: StopReason;
  usage?: Usage;
  // Provider-opaque content replayed unchanged to the provider that produced it (Anthropic's signed
  // thinking blocks). Never shown, never edited; dropped when the history is rewritten.
  replay?: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: object;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal: AbortSignal;
  effort?: "off" | "low" | "medium" | "high"; // overrides the provider's configured reasoning effort
  budget?: number; // overrides the configured thinking budget (tokens; 0 = no cap)
}

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  onOutput?: (chunk: string) => void;
  /** Starts a command as a background job (kinoko's TUI and rpc modes): nothing waits for it. */
  background?: (command: string) => { id: number; pid: number; log: string };
}

/** A tool's answer with images for the model to look at (a picture, a video's frames, a screenshot). */
export interface ToolResult {
  text: string;
  images?: Image[];
}

export interface Tool extends ToolSpec {
  readOnly?: boolean;
  // oxlint-disable-next-line typescript/no-explicit-any -- Tool.run args are validated by schema, so the wire type stays open.
  run(args: any, ctx: ToolContext): Promise<string | ToolResult>;
}
