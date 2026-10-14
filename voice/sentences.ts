// The reply as it streams, cut into sentences to be spoken: each one as soon as it is whole, so the
// voice starts while the model is still writing. Only what reads aloud: code blocks, tables and
// links' addresses are left out, markdown's marks dropped, a link read as its text.

/** Where a sentence ends: . ! ? … and the space after them ("3.5" and "src/loop.ts" go on). */
const END = /[.!?…]+["')\]]*(?=\s)/g;

/** A line of markdown as it reads aloud. */
export function readable(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url): the text
    .replace(/https?:\/\/\S+/g, "") // bare addresses
    .replace(/[*_`~]+/g, "") // emphasis, code marks
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "") // emoji
    .replace(/\s+/g, " ")
    .trim();
}

/** The marks that start a line: a heading, a quote, a list item ("1. " is not a sentence's end). */
const LINE_START = /^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/;
function lineStart(text: string): string {
  return text.replace(LINE_START, "");
}

const speakable = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

export class Sentences {
  /** The line being written. */
  #line = "";
  /** How much of it was already said. */
  #used = 0;
  #fence = false;
  /** What was read but is not a whole sentence yet. */
  #carry = "";

  /** Some more of the reply: the sentences it completed. */
  push(delta: string): string[] {
    const out: string[] = [];
    this.#line += delta;
    let nl = this.#line.indexOf("\n");
    while (nl >= 0) {
      this.#endLine(this.#line.slice(0, nl), out);
      this.#line = this.#line.slice(nl + 1);
      this.#used = 0;
      nl = this.#line.indexOf("\n");
    }
    this.#partial(out);
    return out;
  }

  /** The reply ended: what is left. */
  flush(): string[] {
    const out: string[] = [];
    if (this.#line !== "") this.#endLine(this.#line, out);
    this.reset();
    return out;
  }

  reset(): void {
    this.#line = "";
    this.#used = 0;
    this.#fence = false;
    this.#carry = "";
  }

  /** Not read aloud: inside a code block, a fence, a table row, an indented code line. */
  #silent(line: string): boolean {
    return this.#fence || /^\s*(```|~~~)/.test(line) || /^\s*\|/.test(line) || /^( {4}|\t)/.test(line);
  }

  #endLine(line: string, out: string[]): void {
    if (/^\s*(```|~~~)/.test(line)) {
      this.#emit(out);
      this.#fence = !this.#fence;
      return;
    }
    if (this.#silent(line)) return;
    this.#add(line.slice(this.#used));
    this.#emit(out); // a line ends a sentence: a heading, a list item, a paragraph
  }

  /** The line still being written: the sentences already whole in it. */
  #partial(out: string[]): void {
    if (this.#line === "" || this.#silent(this.#line)) return;
    if (this.#used === 0) this.#used = LINE_START.exec(this.#line)?.[0].length ?? 0;
    END.lastIndex = this.#used;
    for (let m = END.exec(this.#line); m !== null; m = END.exec(this.#line)) {
      const end = m.index + m[0].length;
      this.#add(this.#line.slice(this.#used, end));
      this.#used = end;
      this.#emit(out);
    }
  }

  #add(piece: string): void {
    const text = readable(this.#carry === "" && this.#used === 0 ? lineStart(piece) : piece);
    if (text !== "") this.#carry = this.#carry === "" ? text : `${this.#carry} ${text}`;
  }

  #emit(out: string[]): void {
    if (speakable(this.#carry)) out.push(this.#carry);
    this.#carry = "";
  }
}
