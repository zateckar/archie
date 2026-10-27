/**
 * Pure helpers for `seed.ts` corpus probes: which claim a "what is X?" probe
 * should expect, and how much of it to quote. Free of DB and provider imports
 * so they can be unit-tested.
 *
 * The first version expected each topic's LONGEST claim, cut at 8 words. The
 * longest claim is almost always a narrow rule, not what the topic is, so a
 * case could ask "Co je Microsoft Teams?" and expect "Effective June 1, 2023,
 * placing emergency calls (such" — a mismatched pair that also stops mid-phrase.
 */
import { cosineSimilarity } from '../../src/lib/server/claim-similarity.ts';

export interface ProbeClaim {
    claim_text: string;
    claim_type: string;
    embedding: ArrayLike<number> | null;
}

/**
 * Claim types that state a rule's edge (a condition, a limit, an exception)
 * rather than what something is. A "what is X?" question should not expect them.
 */
const NON_DEFINING_TYPES = new Set(['condition', 'boundary', 'negation', 'comparison']);

/** Topics named after a document or a directive; "Co je PP 1.626?" is not a question anyone asks. */
const DOCUMENT_CODE = /^(document|dokument)\b|^(PP|MP|ID|SP|OS)[\s_.]?\d|\b\d+[._]\d+[._]?\d*\b/i;

/** Claims anchored to a date or a version are about a change, not about the thing. */
const DATED_OPENING = /^(effective|as of|s účinností|platí od)\b|^(from|since|od)\s+\d|^\d{1,2}\.\s?\d{1,2}\.\s?\d{4}|^\d{4}\b/i;

export function isProbeableTopic(name: string): boolean {
    return !DOCUMENT_CODE.test(name.trim());
}

/**
 * The claim that best says what the topic IS: among claims that open with the
 * topic and a defining verb, the one closest to the topic's own embedding.
 * Rule-edge claims and dated claims are excluded. Returns null when no claim qualifies, in which case the
 * topic should not get a probe at all.
 */
export function pickDefiningClaim<T extends ProbeClaim>(
    topic: { name: string; embedding: ArrayLike<number> | null },
    claims: T[]
): T | null {
    const nameTerms = topicTerms(topic.name);
    let best: { claim: T; score: number } | null = null;
    for (const claim of claims) {
        if (NON_DEFINING_TYPES.has(claim.claim_type)) continue;
        const text = claim.claim_text.trim();
        if (DATED_OPENING.test(text)) continue;
        if (!fragmentForProbe(text)) continue;

        if (!definesTopic(text, nameTerms)) continue;

        const score = topic.embedding && claim.embedding
            ? cosineSimilarity(topic.embedding, claim.embedding)
            : 0;
        if (!best || score > best.score) best = { claim, score };
    }
    return best?.claim ?? null;
}

/**
 * A short verbatim quote of the claim for `expectedClaimSubstrings`: the
 * opening clause, 4–12 words, never ending inside brackets or quotes. Returns
 * null when no such quote exists (the claim is too short to be distinctive).
 */
export function fragmentForProbe(text: string, minWords = 4, maxWords = 12): string | null {
    const words = text.trim().split(/\s+/);
    let cut = Math.min(words.length, maxWords);
    // Stop at the first clause boundary once there are enough words.
    for (let i = minWords - 1; i < cut; i++) {
        if (/[,;:.!?]$/.test(words[i]) || /^[(\[–—-]/.test(words[i + 1] ?? '')) {
            cut = i + 1;
            break;
        }
    }
    let fragment = words.slice(0, cut).join(' ');
    // Back off to before an unclosed bracket or quote.
    const open = lastUnclosed(fragment);
    if (open >= 0) fragment = fragment.slice(0, open);
    fragment = fragment.replace(/[\s,;:.!?–—-]+$/, '');
    return fragment.split(/\s+/).filter(Boolean).length >= minWords ? fragment : null;
}

function lastUnclosed(s: string): number {
    const stack: number[] = [];
    const pairs: Record<string, string> = { ')': '(', ']': '[' };
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(' || ch === '[') stack.push(i);
        else if (pairs[ch] && stack.length) stack.pop();
    }
    let quotes = 0, lastQuote = -1;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '"' || s[i] === '„' || s[i] === '“') { quotes++; lastQuote = i; }
    }
    const quoteOpen = quotes % 2 === 1 ? lastQuote : -1;
    return Math.max(stack.length ? stack[0] : -1, quoteOpen);
}

const DEFINING_VERB = '(is|are|stands for|refers to|means|denotes|represents|je|jsou|znamená|označuje|představuje|se rozumí)';

/** "X is responsible / mandatory / the designated owner…" is a duty or a rule, not what X is. */
const NOT_A_DEFINITION = '(the |a |an )?(\\S+ly )?(responsible|required|mandatory|subject|valid|obliged|obligated|designated|not|stored|used|allowed|permitted|prohibited|forbidden|applicable|entitled|authori[sz]ed|accountable|owner|listed|assigned|classified|recorded|involved|associated|located|stored|kept|odpovědn|zodpovědn|povin|platn|oprávněn|zakázán|nutn|při |pokud |if |when )';

/**
 * True when the claim opens with the topic (or its acronym) and says what it
 * is within a few words: "OJ stands for…", "Hypercare is a period…",
 * "IT Produkt je…". Hub topics with 200 claims often have none, and get no probe.
 */
function definesTopic(text: string, terms: string[]): boolean {
    return terms.some((term) => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`^(the |a |an )?${escaped}\\S*(\\s+\\S+){0,3}?\\s+${DEFINING_VERB}\\s+(?!${NOT_A_DEFINITION})`, 'iu').test(text);
    });
}

/** Lowercased name plus its parenthesised acronym: "Network Access Control (NAC)" → both. */
function topicTerms(name: string): string[] {
    const lower = name.toLowerCase();
    const terms = [lower.replace(/\s*\(.*\)\s*/g, ' ').trim()];
    for (const m of lower.matchAll(/\(([^)]+)\)/g)) terms.push(m[1].trim());
    return terms.filter((t) => t.length >= 2);
}
