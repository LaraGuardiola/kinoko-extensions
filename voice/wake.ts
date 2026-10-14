// The wake word: only what starts with kinoko's name is for kinoko ("Kinoko, mira el test"; "Oye
// kinoko, para"). Whisper does not always spell a name it does not know ("Quinoco", "Kinokoko"),
// so the first few words are compared by how they sound, loosely.

/** How a word sounds, roughly, in Spanish and English spelling: "Quinoco" and "kinoko" meet. */
export function sound(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // accents off
    .toLowerCase()
    .replace(/qu|q|ck|c/g, "k")
    .replace(/y/g, "i")
    .replace(/h/g, "")
    .replace(/(.)\1+/g, "$1"); // doubled letters
}

/** Edits from one word to the other (insert, delete, change). */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  return row[b.length] ?? 0;
}

/** Whether `word` is the wake word, as whisper may have written it. */
export function isWake(word: string, wake: string): boolean {
  const heard = sound(word);
  const target = sound(wake);
  // One letter heard wrong ("Kinogo"), but not one missing: "cinco" is not kinoko. "Kinokoko": the
  // name written twice over.
  return (heard.length === target.length && distance(heard, target) <= 1) || (heard.startsWith(target) && heard.length <= target.length + 3);
}

/**
 * What was said after the wake word, when the utterance starts with it (within its first three
 * words: "oye kinoko", "eh, kinoko"): "" for the name alone; undefined when it is not for kinoko.
 */
export function afterWake(text: string, wake: string): string | undefined {
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)].slice(0, 3);
  const at = words.find((w) => isWake(w[0], wake));
  if (at === undefined) return undefined;
  return text
    .slice((at.index ?? 0) + at[0].length)
    .replace(/^[\s,.:;!?¡¿-]+/u, "")
    .trim();
}
