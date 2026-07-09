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
 *
 * Returns:
 *   { displayName, key }
 *   - displayName: cleaned, human-friendly form to store in `topics.name`
 *   - key: lowercase canonical key used purely for de-duplication lookups
 *          (also persisted in `topics.canonical_key` with a UNIQUE index so
 *          that two differently-spelled names for the same concept can never
 *          both be inserted as distinct topics, even under concurrent writes).
 */
export function normalizeTopicName(name: string): { displayName: string; key: string } {
    if (!name) return { displayName: '', key: '' };

    let display = name
        .replace(/[\u2010-\u2015]/g, '-') // unify dashes
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
    //   - collapse hyphen and space
    //   - strip non-alphanumerics
    const key = display
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[-\s]+/g, ' ')
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return { displayName: display, key: key || display.toLowerCase() };
}
