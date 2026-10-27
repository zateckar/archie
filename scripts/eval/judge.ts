/**
 * LLM judge for `npm run eval -- --answers`.
 *
 * Two independent questions, asked in one call:
 *   1. Coverage — which of the expert-written expectedFacts does the answer
 *      state? (Is the answer right?)
 *   2. Support — which statements in the answer have no basis in the context
 *      the answering model was given? (Did it make things up?)
 * Plus a citation count, since answers are now asked to cite inline.
 *
 * A judge is itself a model, so its verdicts are noisy: compare runs on the
 * aggregate, and read the per-case `missingFacts` / `unsupported` lists before
 * believing any single number.
 */
import * as providers from '../../src/lib/server/providers.ts';
import type { AnswerResult } from './types.ts';

const JUDGE_MODEL = process.env.TEXT_MODEL || 'gemini-3-flash-preview';

interface JudgeVerdict {
    coveredFactIndices?: unknown;
    unsupportedStatements?: unknown;
    statementsChecked?: unknown;
    statementsCited?: unknown;
    answersQuestion?: unknown;
    offTopicReason?: unknown;
}

export async function judgeAnswer(
    question: string,
    answer: string,
    context: string,
    expectedFacts: string[]
): Promise<Omit<AnswerResult, 'text'>> {
    const prompt = `You are grading an answer produced by a documentation assistant.

QUESTION:
${question}

CONTEXT the assistant was given (its only permitted source):
${context.slice(0, 60000)}

ANSWER:
${answer}

EXPECTED FACTS (written by a domain expert; a correct answer states each of them, in any wording or language):
${expectedFacts.length > 0 ? expectedFacts.map((f, i) => `[${i}] ${f}`).join('\n') : '(none given)'}

Tasks:
1. coveredFactIndices: indices of EXPECTED FACTS the answer states correctly. A fact stated with a wrong number, name or condition is NOT covered.
2. unsupportedStatements: factual statements in the ANSWER that the CONTEXT does not support (quote each briefly). Ignore greetings, structure and statements that the context does not cover being explicitly flagged as not covered.
3. statementsChecked: how many specific factual statements the answer makes.
4. statementsCited: how many of those carry an inline [source] citation.
5. answersQuestion: false if the answer does not address what was asked: it answers a different question, leads with an unrelated detail (e.g. asked what something is, it states only an incidental rule), or contradicts itself. An honest "the documents do not cover this" counts as addressing it. offTopicReason: one sentence when false, else "".

Return ONLY JSON: {"coveredFactIndices": [..], "unsupportedStatements": [".."], "statementsChecked": n, "statementsCited": n, "answersQuestion": true, "offTopicReason": ""}`;

    const result = await providers.generateContent(
        prompt,
        { model: JUDGE_MODEL },
        { temperature: 0, responseMimeType: 'application/json' },
        { op: 'eval_judge' }
    );
    const verdict = parseVerdict(result.response.text());

    const covered = new Set(
        (Array.isArray(verdict.coveredFactIndices) ? verdict.coveredFactIndices : [])
            .map(Number)
            .filter((i) => Number.isInteger(i) && i >= 0 && i < expectedFacts.length)
    );
    const unsupported = (Array.isArray(verdict.unsupportedStatements) ? verdict.unsupportedStatements : [])
        .filter((s): s is string => typeof s === 'string');
    const checked = Number(verdict.statementsChecked) || 0;
    const cited = Math.min(Number(verdict.statementsCited) || 0, checked);

    return {
        factHits: covered.size,
        factTotal: expectedFacts.length,
        missingFacts: expectedFacts.filter((_, i) => !covered.has(i)),
        unsupported,
        citedRatio: checked > 0 ? cited / checked : 0,
        offTopic: verdict.answersQuestion === false
            ? (typeof verdict.offTopicReason === 'string' && verdict.offTopicReason.trim()) || 'does not address the question'
            : undefined
    };
}

function parseVerdict(text: string): JudgeVerdict {
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch {
                // fall through
            }
        }
        throw new Error('Judge returned unparsable JSON');
    }
}
