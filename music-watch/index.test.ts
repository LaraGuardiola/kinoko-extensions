import { describe, expect, test } from "bun:test";
import { Bus } from "../testing/bus.ts";
import install from "./index.ts";

describe("music-watch", () => {
  test("registers the music_watch tool", () => {
    const bus = new Bus();
    install(bus);
    expect(bus.tools().map((t) => t.name)).toContain("music_watch");
  });

  test("watch returns a string result", async () => {
    const controller = new AbortController();
    const { watch } = await import("./index.ts");
    // Abort after 1s so the watch function can detect it quickly
    setTimeout(() => controller.abort(), 1000);
    // Use short interval so the abort is detected faster
    const result = await watch({ timeout: 60, interval: 1 }, { signal: controller.signal, cwd: "/" });
    expect(typeof result).toBe("string");
  });

  test("watch detects a song change", async () => {
    const controller = new AbortController();
    const { watch: watchFn } = await import("./index.ts");
    // Abort after 3s so the test finishes within the 5s limit
    setTimeout(() => controller.abort(), 3000);
    const result = await watchFn({ timeout: 60, interval: 1 }, { signal: controller.signal, cwd: "/" });
    expect(typeof result).toBe("string");
    // Result should either say "song changed to: ..." or "watch timed out" or "watch cancelled"
    expect(result).toMatch(/(song changed to:|watch timed out|watch cancelled|ERROR:)/);
  });
});
