import { describe, it, expect } from 'vitest';
import { applyProgress, formatStageTime, type ProgressStep } from './chat-progress';

describe('applyProgress', () => {
    it('opens a row on start and closes it on done, keeping the start detail', () => {
        let steps: ProgressStep[] = [];
        steps = applyProgress(steps, { stage: 'analyze', status: 'start' });
        expect(steps).toEqual([{ stage: 'analyze', detail: undefined, done: false }]);
        steps = applyProgress(steps, { stage: 'analyze', status: 'done', detail: 'Kafka SLA', ms: 2100 });
        expect(steps).toEqual([{ stage: 'analyze', detail: 'Kafka SLA', ms: 2100, done: true }]);
    });

    it('keeps repeated stages as separate rows and closes the latest open one', () => {
        let steps: ProgressStep[] = [];
        steps = applyProgress(steps, { stage: 'follow_up', status: 'start', detail: 'q1' });
        steps = applyProgress(steps, { stage: 'follow_up', status: 'done', ms: 1 });
        steps = applyProgress(steps, { stage: 'follow_up', status: 'start', detail: 'q2' });
        steps = applyProgress(steps, { stage: 'follow_up', status: 'done', ms: 2 });
        expect(steps.map((s) => [s.detail, s.ms, s.done])).toEqual([['q1', 1, true], ['q2', 2, true]]);
    });

    it('records a done without a start', () => {
        expect(applyProgress([], { stage: 'answer', status: 'done', ms: 5 }))
            .toEqual([{ stage: 'answer', detail: undefined, ms: 5, done: true }]);
    });
});

describe('formatStageTime', () => {
    it('shows tenths under ten seconds and whole seconds above', () => {
        expect(formatStageTime(420)).toBe('0.4 s');
        expect(formatStageTime(12_345)).toBe('12 s');
        expect(formatStageTime(undefined)).toBe('');
    });
});
