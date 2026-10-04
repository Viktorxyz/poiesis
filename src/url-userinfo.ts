/**
 * Spec #139 / ticket #149 — the ONE URL userinfo redaction rule.
 *
 * A URL authority may carry userinfo: `https://build-bot:<token>@host/p`.
 * The credential in that URL is the Author's. It must never be returned by
 * the process runner, appear in an error's `details`, reach a CLI JSON
 * envelope, a report, a proof, or a published evidence file — and it must
 * never reach a report an Author pastes into an issue.
 *
 * Two surfaces need the rule and they must not drift apart:
 *
 *   - `src/git-remote-url.ts` (ticket #146) redacts a URL Poiesis itself
 *     parsed: a configured remote, read whole, on its own line.
 *   - this module redacts absolute URLs EMBEDDED anywhere in arbitrary
 *     subprocess stdout/stderr (ticket #149): `fatal: unable to access
 *     'https://user:<token>@host/…': …`, a `git remote -v` line, a
 *     verification command's report. The text is not a URL, so the rule
 *     has to find the URLs inside it.
 *
 * The rule is a redaction, not a rewrite. The scheme, host, port, path,
 * query, and fragment survive byte-for-byte, as does every surrounding
 * byte of text, so the remaining output stays diagnosable. The userinfo
 * section is everything between the `scheme://` and the LAST `@` of the
 * authority, exactly as RFC 3986 defines it.
 *
 * Three things are deliberately NOT userinfo and are returned unchanged:
 *
 *   - a credential-free URL (`https://github.com/owner/repo.git`);
 *   - the scp-like SSH form (`git@github.com:owner/repo.git`), which has
 *     no `scheme://` authority at all;
 *   - an unrelated `@` — an email address, or an `@` inside a path or
 *     query (`https://github.com/own@er/repo.git`).
 *
 * ---------------------------------------------------------------------------
 * WHY A SCANNER AND NOT A PATTERN
 * ---------------------------------------------------------------------------
 *
 * The text is untrusted, arbitrarily long, and adversarial in the one way
 * that matters here: a child's output decides where the next URL starts.
 * A `scheme://` can sit directly after another URL's authority with
 * nothing between them —
 *
 *   https://host1,https://a:b@host2
 *
 * — so the authority of the first URL does not stop at the comma or at the
 * second `https`: it stops at the second `://`, and the credentials of the
 * SECOND URL live inside the first one's authority run. A rule that reads
 * each authority as one maximal run therefore cannot see them, and
 * `https://host1,https://a:b@host2` came back with `a:b@` still in it.
 *
 * So this rule is a single left-to-right scan over the string, not a
 * search that restarts:
 *
 *   - a scheme candidate is ASCII `[A-Za-z][A-Za-z0-9+.-]*://` and is
 *     recognized at the start of the text or after a NON-SCHEME byte.
 *     The predecessor rule is what keeps one scheme from being read twice:
 *     in `https://aX://rest` the `X` cannot open a second URL, because the
 *     `a` before it is a scheme byte and `aX` is the scheme.
 *   - the authority is then scanned byte by byte until whitespace or a
 *     control byte, `/`, `?`, `#`, the end of the text, or a new COMPLETE
 *     adjacent scheme candidate. That last stop is the whole point: the
 *     authority is finalized immediately BEFORE the nested candidate and
 *     the candidate itself is not consumed, so it is read as the URL it is
 *     on the very next step of the same pass.
 *   - the LAST `@` seen inside the authority ends the userinfo, and the
 *     half-open range `[authorityStart, lastAt + 1)` is withheld.
 *   - the withheld ranges are collected in order and applied ONCE at the
 *     end. Because the authority is finalized before the nested candidate
 *     and every byte the scan reads moves the cursor forward, two ranges
 *     can never overlap, so applying them needs no ordering repair.
 *
 * The scan visits each byte a bounded number of times, so its cost is
 * linear in the length of the capture. `scanUrlUserinfo` reports the step
 * count (`transitions`) so that linearity is a structural property a test
 * can assert, instead of a hope about wall-clock timing.
 *
 * ---------------------------------------------------------------------------
 * THE ONE CASE A STRING ALONE CANNOT ANSWER
 * ---------------------------------------------------------------------------
 *
 * A TRUNCATED capture. When the runner's byte cap cut the text inside a
 * possible `scheme://authority`, the `@` that proves userinfo may be one
 * of the dropped bytes, so the visible text `https://build-bot:<partial
 * secret>` cannot be told apart from a credential-free host — and the part
 * that was cut may equally have been a host of any length. The runner
 * therefore passes its truncation flag and the rule fails CLOSED on that
 * one case: an authority the capture left OPEN at the end of the text is
 * withheld whole, to the end of the text, whether or not an `@` was seen.
 * A capture that was not truncated ends at a real boundary, so a complete
 * credential-free host-only URL is kept, and an authority that a `/`, `?`,
 * `#` or whitespace already closed is kept even in a truncated capture.
 */

/** The text that replaces an authority that truncation left unterminated. */
export const REDACTED_URL_AUTHORITY = "[redacted]";

export interface SanitizeSubprocessOutputOptions {
  /**
   * True when the runner's byte cap (or an incomplete trailing code
   * point) cut the capture, so the text's end is NOT a real boundary and
   * an unterminated trailing authority may be a partial userinfo.
   */
  truncated?: boolean;
}

/**
 * One withheld input range and the text that takes its place: empty for a
 * userinfo, `REDACTED_URL_AUTHORITY` for an authority the capture left
 * open. Half-open, like every range this module reports.
 */
export interface UrlUserinfoRedaction {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/**
 * The structural result of one pass: the withheld ranges, and how many
 * scan steps it took to find them.
 *
 * `transitions` counts the scan's own advances — one per position the
 * outer cursor visits, plus one per byte an authority scan examines — so a
 * test can bound the work as a function of the input's length. The native
 * `://` pre-filter in `scanUrlUserinfo` is a separate single pass that
 * runs before the scan and is therefore not counted; a capture it rejects
 * reports zero.
 */
export interface UrlUserinfoScan {
  readonly redactions: readonly UrlUserinfoRedaction[];
  readonly transitions: number;
}

const AT = 0x40;
const HASH = 0x23;
const COLON = 0x3a;
const QUESTION = 0x3f;
const SLASH = 0x2f;

const NO_REDACTIONS: UrlUserinfoScan = Object.freeze({ redactions: Object.freeze([]), transitions: 0 });

/**
 * One left-to-right pass that reports the ranges it would withhold, in
 * increasing non-overlapping order, together with the step count.
 */
export function scanUrlUserinfo(text: string, options: SanitizeSubprocessOutputOptions = {}): UrlUserinfoScan {
  // Almost every capture carries no `://` at all, and `includes` is one
  // native pass, so the scanner itself is only entered when there is
  // something for it to look at.
  if (!text.includes("://")) return NO_REDACTIONS;
  const redactions: UrlUserinfoRedaction[] = [];
  const length = text.length;
  const truncated = options.truncated === true;
  let transitions = 0;
  let cursor = 0;

  while (cursor < length) {
    transitions += 1;
    const authorityStart = matchSchemeAt(text, cursor, length);
    if (authorityStart < 0) {
      cursor += 1;
      continue;
    }

    // `authorityStart` is the index just PAST `scheme://`: where the
    // authority begins, and where a withheld userinfo begins.
    let index = authorityStart;
    let lastAt = -1;
    let closed = false;
    while (index < length) {
      const code = text.charCodeAt(index);
      if (isAuthorityTerminator(code)) {
        closed = true;
        break;
      }
      // A complete scheme candidate adjacent to this byte ends the current
      // authority. It is NOT consumed: the cursor lands on it, so the next
      // step of this same pass reads it as the URL it is.
      if (matchSchemeAt(text, index, length) >= 0) {
        closed = true;
        break;
      }
      if (code === AT) lastAt = index;
      index += 1;
      transitions += 1;
    }

    if (!closed && truncated && index > authorityStart) {
      // The capture ends inside this authority, so neither the rest of a
      // userinfo nor the rest of a host can be ruled out. Withhold the whole
      // captured authority, which also subsumes any `@` inside it and keeps
      // the two rules from emitting overlapping ranges.
      redactions.push({ start: authorityStart, end: length, replacement: REDACTED_URL_AUTHORITY });
    } else if (lastAt >= 0) {
      // Userinfo runs from the start of the authority through the LAST `@`,
      // exactly as RFC 3986 defines it (a password may contain `@`).
      redactions.push({ start: authorityStart, end: lastAt + 1, replacement: "" });
    }

    // `index` is at least `authorityStart`, which is at least four bytes
    // past `cursor`, so the cursor always moves forward and the scan ends.
    cursor = index;
  }

  return { redactions, transitions };
}

/**
 * Remove the userinfo from every absolute URL embedded in `text`.
 *
 * Returns `text` unchanged when it contains no `scheme://` at all, and
 * preserves every byte the rule does not have an opinion about — including
 * every authority terminator, which is never rewritten or consumed.
 */
export function sanitizeSubprocessOutput(
  text: string,
  options: SanitizeSubprocessOutputOptions = {},
): string {
  const { redactions } = scanUrlUserinfo(text, options);
  return applyRedactions(text, redactions);
}

/**
 * The index just past a complete `scheme://` at `index`, or -1 when no
 * scheme candidate starts there.
 *
 * The predecessor check is a cost bound rather than a second reading of
 * the grammar. Without it, every position of a run of scheme bytes is
 * re-tested against that run's own end, which on a capture that IS one
 * long run costs the square of its length. Rejecting a candidate that
 * follows a scheme byte settles the position in constant time, and it
 * agrees with the order the scan already guarantees: a run's start is
 * examined before anything inside it, and a suffix of the run can only
 * complete `://` when the whole run does.
 */
function matchSchemeAt(text: string, index: number, length: number): number {
  if (!isAsciiLetter(text.charCodeAt(index))) return -1;
  if (index > 0 && isSchemeByte(text.charCodeAt(index - 1))) return -1;
  let end = index + 1;
  while (end < length && isSchemeByte(text.charCodeAt(end))) end += 1;
  if (end + 3 > length) return -1;
  if (text.charCodeAt(end) !== COLON) return -1;
  if (text.charCodeAt(end + 1) !== SLASH) return -1;
  if (text.charCodeAt(end + 2) !== SLASH) return -1;
  return end + 3;
}

/** A byte RFC 3986 allows inside a scheme: ALPHA / DIGIT / `+` / `-` / `.` */
function isSchemeByte(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2d ||
    code === 0x2e
  );
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

/**
 * A byte that cannot be part of an authority, so it ends one: the RFC's
 * three delimiters, ASCII whitespace and control bytes, and the Unicode
 * separators and format characters JavaScript's `\s` covers — so a line
 * break written as `\r\n`, `\u2028` or a non-breaking space ends an
 * authority exactly as `\n` does, and line structure survives.
 *
 * None of these is a scheme byte, which is what lets the scan tell where
 * an authority run stops without ever reading a scheme run across it.
 */
function isAuthorityTerminator(code: number): boolean {
  if (code <= 0x20) return true;
  if (code === 0x7f) return true;
  if (code === SLASH || code === QUESTION || code === HASH) return true;
  if (code === 0xa0 || code === 0x1680) return true;
  if (code >= 0x2000 && code <= 0x200a) return true;
  if (code === 0x2028 || code === 0x2029) return true;
  if (code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff) return true;
  return false;
}

/**
 * Copy `text` with the ranges applied. The ranges arrive in increasing,
 * non-overlapping order: a URL is finalized before the candidate that
 * ended it, and the cursor never moves backwards, so no later range can
 * start inside an earlier one.
 */
function applyRedactions(text: string, redactions: readonly UrlUserinfoRedaction[]): string {
  if (redactions.length === 0) return text;
  let result = "";
  let copied = 0;
  for (const redaction of redactions) {
    result += `${text.slice(copied, redaction.start)}${redaction.replacement}`;
    copied = redaction.end;
  }
  return result + text.slice(copied);
}

/**
 * Strip the userinfo from a URL that is the WHOLE value (a configured
 * remote). The value is trimmed, and a value with no userinfo — including
 * the scp-like SSH form and a filesystem path — is returned unchanged.
 */
export function stripUrlUserinfo(url: string): string {
  return sanitizeSubprocessOutput(url.trim());
}
