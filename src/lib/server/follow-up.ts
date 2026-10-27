/**
 * Follow-up searches in the answer pipeline: what to search for after the
 * context has been evaluated, and what to tell the answering model about doubts
 * the searches were meant to settle. Pure, so it can be unit-tested.
 */

/** Search rounds after the primary pass. Correctness over latency, but bounded. */
export const MAX_FOLLOW_UP_ROUNDS = 2;

/** Queries per round: coverage gaps first, then doubts to verify. */
const MAX_QUERIES_PER_ROUND = 3;

export interface FollowUpQuery {
    query: string;
    purpose: 'coverage' | 'verify';
}

export function planFollowUpQueries(
    evaluation: {
        sufficient: boolean;
        refinedQueries: string[];
        doubts: { verifyQuery: string }[];
    },
    alreadySearched: Iterable<string>
): FollowUpQuery[] {
    const seen = new Set([...alreadySearched].map(normalize));
    const planned: FollowUpQuery[] = [];
    const add = (query: string, purpose: FollowUpQuery['purpose']) => {
        const key = normalize(query);
        if (!key || seen.has(key) || planned.length >= MAX_QUERIES_PER_ROUND) return;
        seen.add(key);
        planned.push({ query: query.trim(), purpose });
    };
    if (!evaluation.sufficient) {
        for (const q of evaluation.refinedQueries.slice(0, 2)) add(q, 'coverage');
    }
    for (const d of evaluation.doubts) add(d.verifyQuery, 'verify');
    return planned;
}

/**
 * The note appended after the briefing (and after synthesis, so it cannot be
 * paraphrased away) listing doubts that were still open at the last check.
 */
export function verificationNotes(doubts: { fact: string; concern: string }[]): string {
    if (doubts.length === 0) return '';
    const lines = doubts.map((d) => `- "${d.fact}": ${d.concern}`);
    return [
        'VERIFICATION NOTES (raised while checking this briefing; follow-up searches were run and their results are included above):',
        ...lines,
        'If the briefing settles a point, answer from the settled version and cite it. If it does not, tell the user that point is uncertain and why, instead of stating it as fact.'
    ].join('\n');
}

function normalize(q: string): string {
    return q.trim().toLowerCase().replace(/\s+/g, ' ');
}
