/**
 * FTS5 MATCH query construction.
 *
 * Two call sites used to build this inline with near-identical code and a
 * comment claiming they mirrored each other — they had drifted (one emitted
 * prefix matches, the other exact) and both were broken the same way.
 *
 * ── The bug this module exists to fix ──────────────────────────────────────
 *
 * Both sites sanitized with `.replace(/[^\w\s]/g, ' ')`. In JavaScript `\w` is
 * ASCII-only (`[A-Za-z0-9_]`), so every accented letter counted as punctuation
 * and was replaced with a SPACE, shattering the word before SQLite ever saw it:
 *
 *     "řízení projektů"   -> ["zen", "projekt"]
 *     "bezpečnostní"      -> ["bezpe", "nostn"]
 *     "můžeš zdůvodnění"  -> ["vodn"]
 *
 * Measured against the real index: `MATCH '"zen"*'` and `MATCH '"nostn"*'` both
 * return 0 rows, while passing the query through UNTOUCHED works perfectly —
 * `MATCH '"řízení"*'` and `MATCH '"rizeni"*'` each return the same 48 rows.
 *
 * ── Why no folding happens here ────────────────────────────────────────────
 *
 * Deliberately NOT folded, and this is the important design point. `chunks_fts`
 * declares no `tokenize=`, so it uses FTS5's default `unicode61
 * remove_diacritics 1`, which already folds Czech diacritics on BOTH sides — the
 * index side at insert and the query side inside MATCH, because the query text
 * goes through the same tokenizer. Measured: the live index holds 7196 terms and
 * ZERO of them contain an accented character (`řízení` is indexed as `rizeni`).
 *
 * So the tokenizer is already doing the folding correctly and symmetrically. All
 * this module has to do is stop destroying the input first. Folding here would
 * be redundant, and changing the tokenizer would be actively harmful
 * (`remove_diacritics 0` was measured to drop `MATCH '"rizeni"*'` to 0 rows).
 *
 * Contrast with `topic-normalize.ts`, which DOES fold: it builds a key compared
 * by SQL equality, where nothing folds for it. Different contract, hence a
 * separate helper rather than one shared "sanitizer" — see also
 * `normalizeForDuplicateCheck` (aggressive lossy folding) and the LIKE path in
 * `rag.ts` (needs the column side folded, which no JS helper can do).
 */

/**
 * Minimum token length in CODE POINTS. Counted via spread rather than `.length`
 * so a 6-letter Czech word is not judged by its UTF-16 unit count.
 */
const MIN_TOKEN_CODE_POINTS = 3;

export interface FtsQueryOptions {
    /**
     * Append `*` to each token for prefix matching. Czech is heavily inflected, so
     * the surface form in a query ("řízení") often differs from the form indexed
     * elsewhere ("řízeními"); prefix matching recovers that recall.
     */
    prefix?: boolean;
}

/**
 * Builds a safe FTS5 MATCH expression from free text.
 *
 * Returns `null` when no usable token survives, so the caller can skip the FTS
 * branch entirely. That matters: the previous code fell back to the literal
 * `'"*"'`, which is NOT a match-all — it was measured returning 0 rows — so a
 * query made only of short accented words ("změna", "úřad") silently dropped
 * hybrid search to vector-only with no error and no log line.
 *
 * Every token is wrapped in double quotes, which is the ONLY escaping FTS5
 * needs: quoting neutralises every operator character. Unquoted input throws or,
 * worse, silently changes meaning — measured: `rizeni-projektu` raises "no such
 * column: projektu", `rizeni AND` and `(rizeni` raise syntax errors, and a bare
 * `NOT` becomes an operator.
 *
 * The quote-doubling below is unreachable by construction — `tokenizeForFts`
 * classifies `"` as a symbol and splits on it, so no token can contain one. It
 * stays as belt-and-braces in case that strip is ever loosened.
 */
export function buildFtsMatchQuery(text: string, options: FtsQueryOptions = {}): string | null {
    const tokens = tokenizeForFts(text);
    if (tokens.length === 0) return null;

    const suffix = options.prefix ? '*' : '';
    return tokens.map(t => `"${t.replace(/"/g, '""')}"${suffix}`).join(' OR ');
}

/**
 * Splits free text into FTS-safe tokens, preserving all Unicode letters and
 * digits. Exported for unit testing and for callers that need the token list
 * itself rather than a MATCH expression.
 */
export function tokenizeForFts(text: string): string[] {
    if (!text) return [];

    return (text || '')
        // Strip punctuation/symbols but keep every Unicode letter and number.
        // The `u` flag plus \p{...} is what makes this Czech-safe; the ASCII
        // \w this replaced is what broke it.
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .map(w => w.trim())
        .filter(w => [...w].length >= MIN_TOKEN_CODE_POINTS);
}
