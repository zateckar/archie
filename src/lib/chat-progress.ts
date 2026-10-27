/**
 * Progress of one chat turn, streamed to the browser while the answer is being
 * prepared. Shared by the pipeline (which emits it) and the chat page (which
 * renders it), so both agree on the stages.
 *
 * Retrieval, checking and follow-up searches take most of a minute before the
 * first word of the answer; without these the user watched a spinner.
 */
export type ChatStage = 'analyze' | 'retrieve' | 'evaluate' | 'follow_up' | 'synthesize' | 'answer';

export interface ChatProgress {
    stage: ChatStage;
    status: 'start' | 'done';
    /** Short human-readable detail: what was found, what is being verified. */
    detail?: string;
    /** On `done`: how long the stage took. */
    ms?: number;
}

export type ProgressSink = (event: ChatProgress) => void;

/** The label the chat page shows for each stage while it runs. */
export const STAGE_LABELS: Record<ChatStage, string> = {
    analyze: 'Understanding the question',
    retrieve: 'Searching the knowledge graph and documents',
    evaluate: 'Checking completeness and plausibility',
    follow_up: 'Follow-up search',
    synthesize: 'Preparing the briefing',
    answer: 'Thinking about the answer'
};

/** One row of the progress list the chat page keeps per answer. */
export interface ProgressStep {
    stage: ChatStage;
    detail?: string;
    ms?: number;
    done: boolean;
}

/**
 * Folds an event into the step list: a `start` opens a new row (stages such as
 * follow-up searches can repeat), a `done` closes the latest open row of that
 * stage. Pure, so the page's reducer is unit-tested.
 */
export function applyProgress(steps: ProgressStep[], event: ChatProgress): ProgressStep[] {
    if (event.status === 'start') {
        return [...steps, { stage: event.stage, detail: event.detail, done: false }];
    }
    const index = steps.findLastIndex((s) => s.stage === event.stage && !s.done);
    if (index === -1) {
        return [...steps, { stage: event.stage, detail: event.detail, ms: event.ms, done: true }];
    }
    const next = steps.slice();
    next[index] = { ...next[index], detail: event.detail ?? next[index].detail, ms: event.ms, done: true };
    return next;
}

/** Formats a stage duration: "0.4 s", "12 s". */
export function formatStageTime(ms: number | undefined): string {
    if (ms === undefined) return '';
    return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}
