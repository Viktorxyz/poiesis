/**
 * Spec #139 / tickets #149 and #167 — the ONE complete-UTF-8-prefix rule.
 *
 * Two captures keep only a PREFIX of the bytes they received: the subprocess
 * runner's byte cap (`src/process.ts`, ticket #149) and the Linear response
 * ceiling (`src/linear-tracker.ts`, ticket #167). Both then decode those bytes
 * as text, and a decoder handed half a code point does not fail — it
 * substitutes U+FFFD and returns a string that looks like evidence. It is
 * not: a replacement character is Poiesis' own invention inside a body that
 * came from somewhere else, and every byte after a lost boundary is a byte
 * whose position relative to the real document is now unknown.
 *
 * So the text a capture carries is the LONGEST VALID UTF-8 PREFIX of the
 * bytes it received, and the caller learns how much that was. The prefix
 * stops at the first byte that cannot begin (or continue) a code point:
 *
 *   - an invalid lead byte (`0x80`–`0xC1`, `0xF5`–`0xFF`);
 *   - a sequence whose SECOND byte is not a continuation, or that is
 *     overlong (`E0 80`–`E0 9F`), a surrogate (`ED A0`–`ED BF`), or beyond
 *     the Unicode range (`F0 80`–`F0 8F`, `F4 90`–`F4 BF`);
 *   - a code point the capture ran out of bytes for.
 *
 * That last case is the one the two callers share: a byte cap can stop in the
 * middle of a character, and a capture that keeps the partial tail both
 * corrupts the text and hides the fact that the cut happened.
 *
 * There is ONE implementation because the two captures must not drift apart:
 * a subprocess capture and a Linear capture that disagree about where a code
 * point ends would produce two different texts from one rule, and the
 * difference would only ever appear on a body that happened to be cut in the
 * middle of a multibyte character — exactly the case nobody tests by hand.
 *
 * Module-internal: not re-exported by `src/index.ts`.
 */

/**
 * The length of the longest prefix of `bytes` that is complete, valid UTF-8.
 *
 * Half-open like every range: the returned length is the number of bytes that
 * may be decoded, and `bytes.subarray(0, length).toString("utf8")` is the
 * text. A return value SMALLER than `bytes.length` means bytes were dropped,
 * so the caller owes its consumer a truncation flag.
 */
export function completeUtf8PrefixLength(bytes: Uint8Array): number {
  let offset = 0;
  while (offset < bytes.length) {
    const lead = bytes[offset] as number;
    if (lead <= 0x7f) {
      offset += 1;
      continue;
    }

    let width: number;
    if (lead >= 0xc2 && lead <= 0xdf) width = 2;
    else if (lead >= 0xe0 && lead <= 0xef) width = 3;
    else if (lead >= 0xf0 && lead <= 0xf4) width = 4;
    else return offset;
    if (offset + width > bytes.length) return offset;

    const second = bytes[offset + 1] as number;
    if (!isUtf8Continuation(second)) return offset;
    if (lead === 0xe0 && second < 0xa0) return offset;
    if (lead === 0xed && second > 0x9f) return offset;
    if (lead === 0xf0 && second < 0x90) return offset;
    if (lead === 0xf4 && second > 0x8f) return offset;
    for (let index = 2; index < width; index += 1) {
      if (!isUtf8Continuation(bytes[offset + index] as number)) return offset;
    }
    offset += width;
  }
  return offset;
}

function isUtf8Continuation(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}
