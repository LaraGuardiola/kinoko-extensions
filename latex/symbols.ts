// What TeX's commands look like in Unicode: letters, operators, relations, arrows, the big
// operators, accents, and the few letters that have a superscript or subscript form.

export const SYMBOLS: Record<string, string> = {
  // Greek
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ",
  varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ",
  Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // Binary operators
  pm: "±", mp: "∓", times: "×", div: "÷", cdot: "·", ast: "∗", star: "⋆", circ: "∘", bullet: "∙",
  oplus: "⊕", ominus: "⊖", otimes: "⊗", odot: "⊙", cap: "∩", cup: "∪", wedge: "∧", land: "∧",
  vee: "∨", lor: "∨", setminus: "∖", neg: "¬", lnot: "¬",
  // Relations
  le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "∼",
  simeq: "≃", cong: "≅", propto: "∝", ll: "≪", gg: "≫", in: "∈", notin: "∉", ni: "∋",
  subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇", perp: "⊥", parallel: "∥", mid: "∣",
  models: "⊨", vdash: "⊢", prec: "≺", succ: "≻", coloneqq: "≔",
  // Arrows
  to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔", Rightarrow: "⇒",
  Leftarrow: "⇐", Leftrightarrow: "⇔", implies: "⟹", impliedby: "⟸", iff: "⟺", mapsto: "↦",
  uparrow: "↑", downarrow: "↓", longrightarrow: "⟶", longleftarrow: "⟵", hookrightarrow: "↪",
  // Misc
  infty: "∞", partial: "∂", nabla: "∇", forall: "∀", exists: "∃", nexists: "∄", emptyset: "∅",
  varnothing: "∅", ell: "ℓ", hbar: "ℏ", Re: "ℜ", Im: "ℑ", aleph: "ℵ", angle: "∠", triangle: "△",
  dots: "…", ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", prime: "′", degree: "°", top: "⊤",
  bot: "⊥", therefore: "∴", because: "∵", square: "□", checkmark: "✓", dagger: "†",
  lbrace: "{", rbrace: "}", langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈",
  rceil: "⌉", vert: "|", Vert: "‖", backslash: "\\", "{": "{", "}": "}", "%": "%", "$": "$",
  "&": "&", "#": "#", _: "_", "|": "‖",
};

/** Spacing commands: how many columns each leaves. */
export const SPACES: Record<string, number> = { ",": 1, ":": 1, ";": 1, " ": 1, quad: 2, qquad: 4, "!": 0, enspace: 1, thinspace: 1 };

/** Big operators: their glyph, and whether limits go above and below in display. */
export const BIG_OPS: Record<string, string> = {
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮", bigcup: "⋃",
  bigcap: "⋂", bigoplus: "⨁", bigotimes: "⨂", bigvee: "⋁", bigwedge: "⋀",
};

/** Integrals take their limits at the side even in display. */
export const SIDE_LIMITS = new Set(["int", "iint", "iiint", "oint"]);

/** Named operators, set upright; those with limits below in display (lim, max…). */
export const OPERATORS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "log", "ln", "lg", "exp", "det", "dim", "ker", "deg", "gcd", "arg", "hom", "Pr",
  "lim", "limsup", "liminf", "max", "min", "sup", "inf",
]);
export const LIMIT_OPERATORS = new Set(["lim", "limsup", "liminf", "max", "min", "sup", "inf", "Pr", "gcd", "det"]);

/** Accents, as combining marks over one letter (\hat x → x̂). */
export const ACCENTS: Record<string, string> = {
  hat: "̂", widehat: "̂", bar: "̄", overline: "̅", vec: "⃗", dot: "̇",
  ddot: "̈", tilde: "̃", widetilde: "̃", acute: "́", grave: "̀",
  breve: "̆", check: "̌",
};

const SUP_FROM = "0123456789+-=()abcdefghijklmnoprstuvwxyzABDEGHIJKLMNOPRTUVWαβγδεθιφχ";
const SUP_TO = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂᵅᵝᵞᵟᵋᶿᶥᵠᵡ";
const SUB_FROM = "0123456789+-=()aehijklmnoprstuvxβγρφχ";
const SUB_TO = "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓᵦᵧᵨᵩᵪ";

function table(from: string, to: string): Map<string, string> {
  const a = [...from];
  const b = [...to];
  return new Map(a.map((ch, i) => [ch, b[i] ?? ch]));
}
const SUP = table(SUP_FROM, SUP_TO);
const SUB = table(SUB_FROM, SUB_TO);
SUP.set("′", "′").set("∗", "*").set("−", "⁻").set(" ", " ");
SUB.set("−", "₋").set(" ", " ");
// Already raised (x² inside an exponent): kept, as e⁻ˣ² reads.
for (const ch of "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ") SUP.set(ch, ch);

/** `text` in superscript or subscript letters, or undefined when one of them has no such form. */
export function scriptForm(text: string, up: boolean): string | undefined {
  const map = up ? SUP : SUB;
  let out = "";
  for (const ch of text) {
    const to = map.get(ch);
    if (to === undefined) return undefined;
    out += to;
  }
  return out;
}

const BB: Record<string, string> = { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" };
const CAL: Record<string, string> = { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ" };

/** \mathbb and \mathcal letters that have a Unicode form; the rest stay as they are. */
export function letterStyle(style: string, text: string): string {
  const map = style === "mathbb" ? BB : style === "mathcal" ? CAL : undefined;
  if (map === undefined) return text;
  let out = "";
  for (const ch of text) out += map[ch] ?? ch;
  return out;
}
