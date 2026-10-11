import { describe, expect, test } from "bun:test";
import { Bus } from "../testing/bus.ts";
import { textWidth } from "./canvas.ts";
import install, { render } from "./index.ts";

const draw = (source: string, width = 100): string[] => render(source, width, false) ?? ["(source)"];
const widest = (rows: string[]): number => Math.max(...rows.map(textWidth));

describe("mermaid extension", () => {
  test("registers a renderer for mermaid fences", () => {
    const bus = new Bus();
    install(bus);
    expect(bus.renderer("mermaid")?.("pie\n\"a\" : 1", 40)?.length).toBeGreaterThan(0);
  });

  test("unknown diagram kinds and broken sources stay as source", () => {
    expect(render("gantt\ntitle x", 80)).toBeUndefined();
    expect(render("flowchart TD", 80)).toBeUndefined();
    expect(render("", 80)).toBeUndefined();
  });

  test("a top-down flowchart: boxes in their shapes, an arrow down between ranks, labels by the lines", () => {
    const rows = draw("flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C(Done)\n  B -- no --> A");
    const text = rows.join("\n");
    expect(text).toContain("│ Start │");
    expect(text).toContain("╱"); // the decision
    expect(text).toContain("╭"); // the round node
    expect(text).toContain("▼");
    expect(text).toContain("yes");
    expect(text).toContain("no");
    const start = rows.findIndex((r) => r.includes("Start"));
    const ok = rows.findIndex((r) => r.includes("Ok?"));
    expect(ok).toBeGreaterThan(start); // flows down
  });

  test("left to right: the next node is to the right, on the same rows", () => {
    const rows = draw("graph LR\n  A[One] --> B[Two]");
    const row = rows.find((r) => r.includes("One")) ?? "";
    expect(row).toMatch(/One.*▶.*Two/);
  });

  test("chains, &, link styles, a semicolon list and quoted labels all parse", () => {
    const text = draw('graph LR; A & B --> C ==> D -.-> E; E --- F["a [b] c"]').join("\n");
    for (const name of ["A", "B", "C", "D", "E", "a [b] c"]) expect(text).toContain(name);
    expect(text).toContain("━"); // ==> thick
    expect(text).toContain("┄"); // -.-> dotted
  });

  test("subgraphs are framed with their title", () => {
    const text = draw("flowchart LR\n  subgraph Core\n    L[Loop] --> P[Provider]\n  end\n  T[TUI] --> L").join("\n");
    expect(text).toContain("╭┄ Core ┄");
  });

  test("too wide: left-right turns top-down; narrower still, the edges come as a list", () => {
    const src = "graph LR\n  A[A very long first node] --> B[A very long second node] --> C[A very long third node]";
    const mid = draw(src, 50);
    expect(widest(mid)).toBeLessThanOrEqual(50);
    expect(mid.findIndex((r) => r.includes("third"))).toBeGreaterThan(mid.findIndex((r) => r.includes("first")));
    const narrow = draw(src, 12);
    expect(widest(narrow)).toBeLessThanOrEqual(12);
    expect(narrow.join(" ")).toContain("──▶");
  });

  test("every drawing keeps to its width", () => {
    const src = "flowchart TD\n" + Array.from({ length: 8 }, (_, i) => `  N${i}[Node number ${i}] --> N${(i * 3 + 1) % 8}[Node number ${(i * 3 + 1) % 8}]`).join("\n");
    for (const width of [40, 60, 90]) expect(widest(draw(src, width))).toBeLessThanOrEqual(width);
  });

  test("state diagrams: [*] as start and end points, transitions with labels, composite states framed", () => {
    const text = draw("stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy : go\n  Busy --> [*]\n  state Work {\n    Busy\n  }").join("\n");
    expect(text).toContain("●");
    expect(text).toContain("◉");
    expect(text).toContain("go");
    expect(text).toContain("Work");
  });

  test("sequence diagrams: participants, lifelines, arrows both ways, blocks and notes", () => {
    const rows = draw(
      "sequenceDiagram\n  autonumber\n  participant A as Alice\n  participant B as Bob\n  A->>B: hello\n  loop every second\n    B-->>A: ping\n  end\n  Note over A,B: friends\n  A->>A: think",
    );
    const text = rows.join("\n");
    expect(rows[1]).toMatch(/Alice.*Bob/);
    expect(text).toContain("1. hello");
    expect(text).toContain("▶");
    expect(text).toContain("◀┄");
    expect(text).toContain("loop · every second");
    expect(text).toContain("friends");
    expect(text).toContain("3. think");
    expect(rows.at(-2)).toMatch(/Alice.*Bob/); // the participants again at the foot
  });

  test("a sequence too wide for the width becomes a list", () => {
    const rows = draw("sequenceDiagram\n  Alice->>Bob: a fairly long message that needs room\n  Bob-->>Alice: ok", 24);
    expect(widest(rows)).toBeLessThanOrEqual(24);
    expect(rows[0]).toStartWith("Alice ──▶ Bob:");
  });

  test("pie charts as bars with their shares", () => {
    const rows = draw('pie title Pets\n  "Dogs" : 3\n  "Cats" : 1', 40);
    expect(rows[0]).toBe("Pets");
    expect(rows[2]).toMatch(/^Dogs +█+ +75\.0%$/);
    expect(rows[3]).toMatch(/^Cats +█+.* +25\.0%$/);
  });
});
