/**
 * Shared topic-name normalisation.
 *
 * Extracted from knowledge.ts so that both the knowledge-extraction pipeline
 * (knowledge.ts) and the database layer (db.ts, for canonical_key backfill/
 * migrations) can use the exact same normalisation logic without creating a
 * circular import between them.
 *
 * Goals:
 *   - Collapse hyphen / space / underscore variants ("IT-PEP" == "IT PEP" == "IT_PEP").
 *   - Strip trailing categorical suffixes that don't change the concept.
 *   - Strip parenthetical aliases for matching purposes ("AMS (Application Management Service)" -> "AMS").
 *   - Be case-insensitive on the comparison key while preserving a clean display form.
 *   - Fold diacritics rather than deleting them, so accented names survive
 *     keying ("Řízení projektů" == "Rizeni projektu"). See `foldDiacritics`.
 */

/**
 * Latin letters that carry no combining mark under NFD and so survive
 * decomposition unchanged. Without this map the ASCII strip in
 * `normalizeTopicName` would delete them outright and two spellings of the same
 * word would key differently. Czech itself only needs the NFD path, but the
 * corpus carries German and Polish proper nouns, so the cheap cases are here too.
 */
const NON_DECOMPOSING_LATIN: Record<string, string> = {
    'ß': 'ss',
    'æ': 'ae',
    'œ': 'oe',
    'ø': 'o',
    'đ': 'd',
    'ð': 'd',
    'ł': 'l',
    'þ': 'th',
    'ħ': 'h',
    'ı': 'i'
};

const COMBINING_MARK_START = 0x0300;
const COMBINING_MARK_END = 0x036f;

/**
 * Fold accented Latin text down to ASCII.
 *
 * NFD splits a precomposed character into its base letter plus combining marks
 * (`ř` becomes `r` + a combining caron), and dropping the combining range then
 * leaves the base letter behind. This must run *before* the `[^a-z0-9 ]` strip
 * in `normalizeTopicName`. Previously that strip removed the accented character
 * outright, which broke a Czech corpus two ways: "Řízení" keyed as "zen" and
 * "Řešení" as "een" (identity destroyed, unrelated topics free to collide), and
 * "Řízení projektů" vs "Rizeni projektu" — the same concept typed with and
 * without diacritics — keyed differently and so were never merged.
 *
 * Iterating code points rather than using a literal combining-mark character
 * class keeps the source readable; combining marks are invisible in an editor.
 *
 * Exported for direct unit testing.
 */
export function foldDiacritics(input: string): string {
    let out = '';
    for (const ch of input.normalize('NFD')) {
        const code = ch.codePointAt(0);
        if (code !== undefined && code >= COMBINING_MARK_START && code <= COMBINING_MARK_END) {
            continue;
        }
        // Looked up case-insensitively so 'Ł' folds as well as 'ł'. The key
        // path lowercases before folding, but this function is exported and
        // must not be case-sensitive in a way callers would not expect.
        const lower = ch.toLowerCase();
        const folded = NON_DECOMPOSING_LATIN[lower];
        if (folded === undefined) {
            out += ch;
        } else if (ch === lower) {
            out += folded;
        } else {
            out += folded.charAt(0).toUpperCase() + folded.slice(1);
        }
    }
    return out;
}

/**
 * Returns:
 *   { displayName, key }
 *   - displayName: cleaned, human-friendly form to store in `topics.name`.
 *     Diacritics are preserved here — only the key is folded.
 *   - key: lowercase canonical key used purely for de-duplication lookups
 *          (also persisted in `topics.canonical_key` with a UNIQUE index so
 *          that two differently-spelled names for the same concept can never
 *          both be inserted as distinct topics, even under concurrent writes).
 */
export function normalizeTopicName(name: string): { displayName: string; key: string } {
    if (!name) return { displayName: '', key: '' };

    let display = name
        .replace(/[‐-―]/g, '-') // unify dashes
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Strip a trailing categorical suffix that does not add semantic information.
    display = display.replace(
        /\s+(Methodology|Methodologies|Process|Processes|Guideline|Guidelines|Policy|Policies|Standard|Standards|Framework|Frameworks)$/i,
        ''
    );

    if (!display) display = name.trim();

    // Build a robust matching key:
    //   - lowercase
    //   - drop parenthetical content
    //   - fold diacritics to their ASCII base letter
    //   - collapse hyphen and space
    //   - strip remaining non-alphanumerics
    const key = foldDiacritics(display.toLowerCase().replace(/\([^)]*\)/g, ' '))
        .replace(/[-\s]+/g, ' ')
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return { displayName: display, key: key || display.toLowerCase() };
}
