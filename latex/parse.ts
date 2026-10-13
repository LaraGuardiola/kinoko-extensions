// TeX math into a small tree: symbols, groups, scripts, fractions, roots, big operators,
// \left…\right, environments (matrices, cases, aligned), text. What it cannot read throws:
// the caller shows the source then.

import { ACCENTS, BIG_OPS, LIMIT_OPERATORS, OPERATORS, SIDE_LIMITS, SPACES, SYMBOLS, letterStyle } from "./symbols.ts";

/** How a symbol spaces itself: binary operators and relations get room around them. */
export type Kind = "ord" | "bin" | "rel" | "open" | "close" | "punct";

export type Node =
  | { k: "sym"; s: string; kind: Kind }
  | { k: "row"; items: Node[] }
  | { k: "frac"; num: Node; den: Node }
  | { k: "sqrt"; body: Node; index?: Node }
  | { k: "scripts"; base: Node; sup?: Node; sub?: Node }
  | { k: "op"; s: string; limits: boolean } // ∑, lim: limits above and below in display
  | { k: "delim"; left: string; right: string; body: Node }
  | { k: "grid"; rows: Node[][]; left: string; right: string; align: string }
  | { k: "space"; n: number };

const BIN = new Set([..."+-*/", "±", "∓", "×", "÷", "·", "∗", "⋆", "∘", "∙", "⊕", "⊖", "⊗", "⊙", "∩", "∪", "∧", "∨", "∖"]);
const REL = new Set([..."=<>:", "≤", "≥", "≠", "≈", "≡", "∼", "≃", "≅", "∝", "≪", "≫", "∈", "∉", "∋", "⊂", "⊃", "⊆", "⊇", "⊥", "∥", "∣", "⊨", "⊢", "≺", "≻", "≔", "→", "←", "↔", "⇒", "⇐", "⇔", "⟹", "⟸", "⟺", "↦", "↑", "↓", "⟶", "⟵", "↪"]);

function kindOf(s: string): Kind {
  if (BIN.has(s)) return "bin";
  if (REL.has(s)) return "rel";
  if ("([{⟨⌊⌈".includes(s)) return "open";
  if (")]}⟩⌋⌉".includes(s)) return "close";
  if (",;".includes(s)) return "punct";
  return "ord";
}

const sym = (s: string, kind: Kind = kindOf(s)): Node => ({ k: "sym", s, kind });
const row = (items: Node[]): Node => (items.length === 1 ? items[0]! : { k: "row", items });

/** \left( … \right): the delimiters each one names (`.` is none). */
const DELIMS: Record<string, string> = { ".": "", "(": "(", ")": ")", "[": "[", "]": "]", "|": "|", "\\{": "{", "\\}": "}", "\\lbrace": "{", "\\rbrace": "}", "\\langle": "⟨", "\\rangle": "⟩", "\\|": "‖", "\\Vert": "‖", "\\vert": "|", "\\lfloor": "⌊", "\\rfloor": "⌋", "\\lceil": "⌈", "\\rceil": "⌉", "<": "⟨", ">": "⟩" };

/** Environments drawn as a grid: their brackets and how their columns line up. */
const ENVS: Record<string, { left: string; right: string; align: string }> = {
  matrix: { left: "", right: "", align: "c" }, smallmatrix: { left: "", right: "", align: "c" },
  pmatrix: { left: "(", right: ")", align: "c" }, bmatrix: { left: "[", right: "]", align: "c" },
  Bmatrix: { left: "{", right: "}", align: "c" }, vmatrix: { left: "|", right: "|", align: "c" },
  Vmatrix: { left: "‖", right: "‖", align: "c" }, cases: { left: "{", right: "", align: "l" },
  array: { left: "", right: "", align: "c" }, aligned: { left: "", right: "", align: "rl" },
  align: { left: "", right: "", align: "rl" }, "align*": { left: "", right: "", align: "rl" },
  alignat: { left: "", right: "", align: "rl" }, split: { left: "", right: "", align: "rl" },
  gathered: { left: "", right: "", align: "c" }, gather: { left: "", right: "", align: "c" },
  "gather*": { left: "", right: "", align: "c" }, equation: { left: "", right: "", align: "c" },
  "equation*": { left: "", right: "", align: "c" }, multline: { left: "", right: "", align: "c" },
};

/** Commands that only change TeX's sizes or styles: dropped. */
const IGNORED = new Set(["displaystyle", "textstyle", "scriptstyle", "limits", "nolimits", "left.", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "label", "nonumber", "notag", "tag"]);

type Token = { t: "cmd"; v: string } | { t: "char"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < src.length; ) {
    const ch = src[i]!;
    if (ch === "\\") {
      const name = /^\\([a-zA-Z]+\*?|.)/.exec(src.slice(i));
      if (!name) throw new Error("a lone backslash");
      out.push({ t: "cmd", v: name[1]! });
      i += name[0].length;
      // A command's name ends at the first non-letter; the spaces after it are TeX's, not ours.
      if (/^[a-zA-Z]/.test(name[1]!)) while (src[i] === " ") i++;
      continue;
    }
    if (ch === "%") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    const code = src.codePointAt(i)!;
    const text = String.fromCodePoint(code);
    out.push({ t: "char", v: text });
    i += text.length;
  }
  return out;
}

class Parser {
  #i = 0;
  constructor(private readonly tokens: Token[]) {}

  #peek(): Token | undefined {
    return this.tokens[this.#i];
  }

  #next(): Token {
    const tok = this.tokens[this.#i++];
    if (tok === undefined) throw new Error("ended too soon");
    return tok;
  }

  #skipSpace(): void {
    while (this.#peek()?.t === "char" && /\s/.test(this.#peek()!.v)) this.#i++;
  }

  #expect(ch: string): void {
    this.#skipSpace();
    const tok = this.#next();
    if (tok.t !== "char" || tok.v !== ch) throw new Error(`expected ${ch}`);
  }

  /** Everything up to `}`, `&`, `\\`, \end or \right, left for the caller; `]` too inside \sqrt[…]. */
  expr(bracket = false): Node {
    const items: Node[] = [];
    for (;;) {
      this.#skipSpace();
      const tok = this.#peek();
      if (tok === undefined) break;
      if (tok.t === "char" && (tok.v === "}" || tok.v === "&" || (bracket && tok.v === "]"))) break;
      if (tok.t === "cmd" && (tok.v === "\\" || tok.v === "end" || tok.v === "right" || tok.v === "cr")) break;
      if (tok.t === "char" && (tok.v === "^" || tok.v === "_" || tok.v === "'")) {
        const base = items.pop() ?? sym("");
        items.push(this.#scripts(base));
        continue;
      }
      const atom = this.#atom();
      if (atom !== undefined) items.push(atom);
    }
    return row(items);
  }

  /** `^` and `_` after a base, in either order, and primes. */
  #scripts(base: Node): Node {
    let sup: Node | undefined;
    let sub: Node | undefined;
    let primes = "";
    for (;;) {
      const tok = this.#peek();
      if (tok?.t !== "char") break;
      if (tok.v === "'") {
        this.#i++;
        primes += "′";
      } else if (tok.v === "^" || tok.v === "_") {
        this.#i++;
        const arg = this.#arg();
        if (tok.v === "^") sup = arg;
        else sub = arg;
      } else break;
    }
    if (primes !== "") sup = sup === undefined ? sym(primes, "ord") : row([sym(primes, "ord"), sup]);
    return { k: "scripts", base, sup, sub };
  }

  /** One argument: a {group}, a command, or one character. */
  #arg(): Node {
    this.#skipSpace();
    const tok = this.#peek();
    if (tok?.t === "char" && tok.v === "{") return this.#group();
    const atom = this.#atom();
    return atom ?? sym("");
  }

  #group(): Node {
    this.#expect("{");
    const body = this.expr();
    this.#expect("}");
    return body;
  }

  /** A {group} read as plain text: \text{…}, \operatorname{…}, environment names. */
  #rawGroup(): string {
    this.#expect("{");
    let depth = 0;
    let out = "";
    for (;;) {
      const tok = this.#next();
      if (tok.t === "char" && tok.v === "{") depth++;
      if (tok.t === "char" && tok.v === "}" && depth-- === 0) return out;
      out += tok.t === "cmd" ? (SYMBOLS[tok.v] ?? (tok.v === " " ? " " : "")) : tok.v;
    }
  }

  #atom(): Node | undefined {
    const tok = this.#next();
    if (tok.t === "char") {
      if (tok.v === "{") {
        this.#i--;
        return this.#group();
      }
      if (tok.v === "~") return { k: "space", n: 1 };
      if (tok.v === "-") return sym("−", "bin");
      if (tok.v === "*") return sym("∗", "bin");
      return sym(tok.v);
    }
    return this.#command(tok.v);
  }

  #command(name: string): Node | undefined {
    if (IGNORED.has(name)) return undefined;
    if (name in SPACES) return SPACES[name]! > 0 ? { k: "space", n: SPACES[name]! } : undefined;
    if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") return { k: "frac", num: this.#arg(), den: this.#arg() };
    if (name === "binom" || name === "dbinom" || name === "tbinom") {
      const top = this.#arg();
      const bottom = this.#arg();
      return { k: "delim", left: "(", right: ")", body: { k: "grid", rows: [[top], [bottom]], left: "", right: "", align: "c" } };
    }
    if (name === "sqrt") {
      this.#skipSpace();
      let index: Node | undefined;
      if (this.#peek()?.t === "char" && this.#peek()!.v === "[") {
        this.#i++;
        index = this.expr(true);
        this.#expect("]");
      }
      return { k: "sqrt", body: this.#arg(), index };
    }
    if (name === "left") return this.#leftRight();
    if (name === "begin") return this.#environment();
    if (name === "text" || name === "textrm" || name === "textit" || name === "textbf" || name === "mbox" || name === "mathrm" || name === "textsf" || name === "texttt") {
      return sym(this.#rawGroup(), "ord");
    }
    if (name === "operatorname" || name === "operatorname*") return { k: "op", s: this.#rawGroup(), limits: name.endsWith("*") };
    if (name === "mathbb" || name === "mathcal" || name === "mathbf" || name === "mathit" || name === "boldsymbol" || name === "bm" || name === "mathsf" || name === "mathfrak" || name === "mathscr") {
      const arg = this.#arg();
      return name === "mathbb" || name === "mathcal" ? mapText(arg, (s) => letterStyle(name, s)) : arg;
    }
    if (name in ACCENTS) {
      const mark = ACCENTS[name]!;
      return mapText(this.#arg(), (s) => [...s].map((ch) => ch + mark).join(""));
    }
    if (name === "underline") return this.#arg();
    if (name === "overbrace" || name === "underbrace" || name === "boxed" || name === "phantom") return this.#arg();
    if (name === "not") {
      const next = this.#arg();
      return mapText(next, (s) => (s === "=" ? "≠" : s === "∈" ? "∉" : `${s}̸`));
    }
    if (name in BIG_OPS) return { k: "op", s: BIG_OPS[name]!, limits: !SIDE_LIMITS.has(name) };
    if (OPERATORS.has(name)) return { k: "op", s: name, limits: LIMIT_OPERATORS.has(name) };
    if (name in SYMBOLS) return sym(SYMBOLS[name]!);
    throw new Error(`unknown command \\${name}`);
  }

  #leftRight(): Node {
    const left = this.#delimiter();
    const body = this.expr();
    const tok = this.#next();
    if (tok.t !== "cmd" || tok.v !== "right") throw new Error("\\left without \\right");
    return { k: "delim", left, right: this.#delimiter(), body };
  }

  #delimiter(): string {
    this.#skipSpace();
    const tok = this.#next();
    const key = tok.t === "cmd" ? `\\${tok.v}` : tok.v;
    const d = DELIMS[key];
    if (d === undefined) throw new Error(`unknown delimiter ${key}`);
    return d;
  }

  #environment(): Node {
    const name = this.#rawGroup();
    const env = ENVS[name];
    if (env === undefined) throw new Error(`unknown environment ${name}`);
    // array{cc} and alignat{2}: the column spec is read and dropped.
    if ((name === "array" || name === "alignat") && this.#peek()?.t === "char" && this.#peek()!.v === "{") this.#rawGroup();
    return { k: "grid", rows: this.cells(name), ...env };
  }

  /** Cells split by & and rows by \\, up to \end{name} (or the end of the source, with no name). */
  cells(name?: string): Node[][] {
    const rows: Node[][] = [[]];
    for (;;) {
      rows.at(-1)!.push(this.expr());
      if (name === undefined && this.done()) break;
      const tok = this.#next();
      if (tok.t === "char" && tok.v === "&") continue;
      if (tok.t === "cmd" && (tok.v === "\\" || tok.v === "cr")) {
        rows.push([]);
        continue;
      }
      if (name !== undefined && tok.t === "cmd" && tok.v === "end") {
        if (this.#rawGroup() !== name) throw new Error(`\\end does not match ${name}`);
        break;
      }
      throw new Error("unbalanced braces or a stray token");
    }
    // A trailing \\ leaves an empty last row.
    const last = rows.at(-1)!;
    if (rows.length > 1 && last.length === 1 && isEmpty(last[0]!)) rows.pop();
    return rows;
  }

  done(): boolean {
    this.#skipSpace();
    return this.#i >= this.tokens.length;
  }
}

function isEmpty(node: Node): boolean {
  return (node.k === "row" && node.items.length === 0) || (node.k === "sym" && node.s === "");
}

/** The same tree with every symbol's text passed through `f` (\mathbb{R}, \hat{x}). */
function mapText(node: Node, f: (s: string) => string): Node {
  if (node.k === "sym") return { ...node, s: f(node.s) };
  if (node.k === "row") return { k: "row", items: node.items.map((n) => mapText(n, f)) };
  return node;
}

/** The tree of a whole formula; throws on anything it cannot read. A bare & or \\ (an aligned
 *  block without its environment, as models write inside $$) makes a grid, like aligned. */
export function parse(src: string): Node {
  const rows = new Parser(tokenize(src)).cells();
  return rows.length === 1 && rows[0]!.length === 1 ? rows[0]![0]! : { k: "grid", rows, left: "", right: "", align: "rl" };
}
