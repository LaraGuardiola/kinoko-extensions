// The microphone, as a stream of 16-bit mono PCM: PipeWire's pw-record writing raw audio to its
// stdout, until it is stopped.

export const RATE = 16_000;
export const RECORD = ["pw-record", "--raw", "--rate", String(RATE), "--channels", "1", "--format", "s16", "-"];

export interface Mic {
  stop(): void;
}

/** Starts `argv` and hands its audio over as it comes; `ended` when it stops (why, if it failed). */
export function openMic(argv: string[], heard: (pcm: Int16Array) => void, ended: (why?: string) => void): Mic {
  const stopper = new AbortController();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: stopper.signal });
  } catch (e) {
    queueMicrotask(() => ended(`${argv[0]} did not start: ${e instanceof Error ? e.message : String(e)}`));
    return { stop: () => undefined };
  }
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  void (async () => {
    let odd: number | undefined; // a sample split between two chunks
    try {
      for await (const chunk of stdout) {
        const bytes = odd === undefined ? chunk : Uint8Array.of(odd, ...chunk);
        odd = bytes.length % 2 === 1 ? bytes.at(-1) : undefined;
        const whole = bytes.length - (bytes.length % 2);
        heard(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + whole)));
      }
    } catch {
      // stopped
    }
    const code = await proc.exited;
    const err = await new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");
    ended(stopper.signal.aborted || code === 0 ? undefined : `${argv[0]} stopped (${code}): ${err.trim().split("\n").at(-1) ?? ""}`);
  })();
  return { stop: () => stopper.abort() };
}
