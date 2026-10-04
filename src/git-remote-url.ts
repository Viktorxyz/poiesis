/**
 * Spec #139 / ticket #146 — the ONE Git remote URL sanitization seam.
 *
 * A configured remote may carry userinfo:
 * `https://build-bot:<token>@github.com/owner/repo.git`. The credential in
 * that URL is the Author's, must never be retained in a Poiesis coordinate,
 * report, error detail, CLI JSON envelope, or log line, and must never reach
 * a published evidence file.
 *
 * Every surface that parses or reports a remote URL routes through
 * `sanitizeGitRemoteUrl`:
 *
 *   - `parseGitHubProject` / `parseGitLabProject` / `parseTrackerFromUrl`
 *     sanitize BEFORE matching, so a supported HTTPS remote that carries
 *     userinfo still resolves to its repository coordinate and the
 *     credential is never returned;
 *   - the doctor `git-remote` check, init discovery, the Git inspection the
 *     `poiesis inspect` command prints, and the `PUBLISH_PROVIDER_UNRESOLVED`
 *     details sanitize before they serialize.
 *
 * The rule is deliberately narrow: userinfo is removed, and the host, port,
 * path, scheme, and the scp-like SSH form are preserved byte-for-byte. This
 * is a redaction, not a rewriter — `git@github.com:owner/repo.git` has no
 * userinfo section and stays exactly as the Author wrote it.
 *
 * Spec #139 / ticket #149: the rule itself now lives in
 * `src/url-userinfo.ts`, next to the same rule applied to absolute URLs
 * embedded in arbitrary subprocess output. A remote URL is a whole URL,
 * so this function is that single rule with a whole-value shape — one rule,
 * two shapes, no possibility of the two drifting apart.
 */
import { stripUrlUserinfo } from "./url-userinfo.js";

/**
 * Strip the userinfo section from a Git remote URL.
 *
 * Only the URL's own `scheme://userinfo@` prefix is removed. A URL without a
 * scheme (a filesystem path, or the scp-like `git@host:owner/repo.git` SSH
 * form) has no userinfo section to remove and is returned unchanged, as is a
 * credential-free URL.
 */
export function sanitizeGitRemoteUrl(url: string): string {
  return stripUrlUserinfo(url);
}
