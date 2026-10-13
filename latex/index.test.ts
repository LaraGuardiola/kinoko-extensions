import { describe, expect, test } from "bun:test";
import { Bus } from "../testing/bus.ts";
import install, { render, renderInline } from "./index.ts";
import { textWidth } from "./layout.ts";
import { scriptForm } from "./symbols.ts";

const draw = (source: string, width = 80): string => (render(source, width) ?? ["(source)"]).join("\n");
const one = (source: string): string => renderInline(source, 80)?.[0] ?? "(source)";

describe("latex extension", () => {
  test("registers display renderers for math fences and an inline one", () => {
    const bus = new Bus();
    install(bus);
    for (const lang of ["math", "latex", "tex"]) expect(bus.renderer(lang)?.("x^2", 40)).toEqual(["x²"]);
    expect(bus.renderer("math-inline")?.("\\alpha + \\beta", 40)).toEqual(["α + β"]);
  });

  test("inline: one line, scripts and symbols in Unicode, room around operators", () => {
    expect(one("x^2 + y^2 = r^2")).toBe("x² + y² = r²");
    expect(one("a_{ij}")).toBe("aᵢⱼ");
    expect(one("\\frac{a+b}{2}")).toBe("(a+b)/2");
    expect(one("O(n \\log n)")).toBe("O(n log n)");
    expect(one("\\forall x \\in \\mathbb{R}, x^2 \\ge 0")).toBe("∀x ∈ ℝ, x² ≥ 0");
    expect(one("e^{-x^2}")).toBe("e⁻ˣ²");
    expect(one("2^{n+1}")).toBe("2ⁿ⁺¹");
    expect(one("x^{1/2}")).toBe("x^(1/2)"); // no superscript slash: spelled out
    expect(one("\\hat{x}")).toBe("x\u0302");
    expect(one("\\int_0^1 f")).toBe("∫₀¹ f");
  });

  test("a fraction is stacked: numerator, a bar as wide as the widest, denominator", () => {
    const rows = draw("\\frac{a+b}{2}").split("\n");
    expect(rows).toEqual(["a + b", "─────", "  2"].map((r, i) => (i === 1 ? "───────" : ` ${r}`)).map((r) => r.trimEnd()));
  });

  test("the quadratic formula: the root's bar over its body, all on the fraction's line", () => {
    const rows = draw("x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}").split("\n");
    expect(rows).toHaveLength(4);
    expect(rows[2]).toMatch(/^x = ─+$/);
    expect(rows[1]).toContain("−b ± √b² − 4ac");
    expect(rows[0]!.indexOf("_")).toBe(rows[1]!.indexOf("√") + 1); // the bar sits on the radicand
  });

  test("∑ and lim carry their limits above and below; ∫ at its side", () => {
    expect(draw("\\sum_{i=1}^{n} i").split("\n")).toEqual([" n", " ∑  i", "i=1"].map((r) => r.padEnd(5).trimEnd()));
    const lim = draw("\\lim_{x \\to 0} f(x)").split("\n");
    expect(lim[0]).toBe("lim f(x)");
    expect(lim[1]).toBe("x→0");
    const int = draw("\\int_0^1 x \\, dx").split("\n");
    expect(int).toEqual([" 1", "∫  x dx", " 0"]);
  });

  test("matrices get tall brackets; cases a brace; aligned lines line up on their &", () => {
    expect(draw("\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}")).toBe("⎛ 1  2 ⎞\n⎝ 3  4 ⎠");
    expect(draw("\\begin{bmatrix} a \\\\ b \\\\ c \\end{bmatrix}")).toBe("⎡ a ⎤\n⎢ b ⎥\n⎣ c ⎦");
    expect(draw("|x| = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}")).toBe("|x| = ⎰ x     x ≥ 0\n      ⎱ −x    x < 0");
    const aligned = draw("\\begin{aligned} f(x) &= (x+1)^2 \\\\ &= x^2 + 2x + 1 \\end{aligned}").split("\n");
    expect(aligned).toEqual(["f(x) = (x + 1)²", "     = x² + 2x + 1"]);
    // The same written bare inside $$, as models do: still aligned.
    expect(draw("a &= b \\\\ c &= d")).toBe("a = b\nc = d");
  });

  test("\\left…\\right grows with what it holds", () => {
    const rows = draw("\\left( \\frac{a}{b} \\right)").split("\n");
    expect(rows).toEqual(["⎛ a ⎞", "⎜───⎟", "⎝ b ⎠"]);
  });

  test("too wide to stack: one line; narrower still, or unreadable: the source stays", () => {
    const src = "\\frac{a_1 + a_2 + a_3 + a_4}{n} = \\bar{a}";
    expect(render(src, 30)?.length).toBeGreaterThan(1);
    expect(render(src, 14)).toBeUndefined();
    expect(render("\\frac{a}{", 80)).toBeUndefined();
    expect(render("\\unknowncommand{x}", 80)).toBeUndefined();
    expect(render("\\begin{tikzpicture}\\end{tikzpicture}", 80)).toBeUndefined();
    expect(renderInline("x}", 80)).toBeUndefined();
  });

  test("every row fits its width and the script tables line up", () => {
    for (const src of ["\\sum_{k=0}^{\\infty} \\frac{x^k}{k!} = e^x", "\\sqrt[3]{\\frac{1}{2}}", "\\binom{n}{k} = \\frac{n!}{k!(n-k)!}"]) {
      const rows = render(src, 40) ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(textWidth(r)).toBeLessThanOrEqual(40);
    }
    expect(scriptForm("0123456789", true)).toBe("⁰¹²³⁴⁵⁶⁷⁸⁹");
    expect(scriptForm("ijkn", false)).toBe("ᵢⱼₖₙ");
    expect(scriptForm("q", false)).toBeUndefined();
  });
});
