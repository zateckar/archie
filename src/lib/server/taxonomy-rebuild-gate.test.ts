import { describe, it, expect } from 'vitest';
import { taxonomyNeedsFullRebuild } from './knowledge';

/**
 * The predicate that decides whether a git sync may settle for cheap incremental
 * placement or has to pay for a full taxonomy rebuild.
 *
 * Worth pinning down, because getting it wrong is expensive in one direction and
 * silently lossy in the other: too eager and every sync re-sends the whole topic
 * set to the model (the behaviour this replaced — 24 full rebuilds a day on an
 * idle repo), too reluctant and a freshly imported corpus never gets a hierarchy
 * at all, since incremental placement has no parents to attach anything to.
 */
describe('taxonomyNeedsFullRebuild', () => {
    it('demands a full rebuild for a fresh corpus with no hierarchy', () => {
        expect(taxonomyNeedsFullRebuild(50, 0)).toBe(true);
        expect(taxonomyNeedsFullRebuild(1500, 2)).toBe(true);
    });

    it('leaves a corpus that already has structure to incremental placement', () => {
        expect(taxonomyNeedsFullRebuild(50, 3)).toBe(false);
        expect(taxonomyNeedsFullRebuild(1500, 900)).toBe(false);
    });

    it('does not rebuild a corpus too small to have a meaningful hierarchy', () => {
        // Five topics and no parents is not a broken taxonomy, it is a taxonomy
        // that has nothing to say yet. Rebuilding it buys nothing.
        for (let topics = 0; topics <= 5; topics++) {
            expect(taxonomyNeedsFullRebuild(topics, 0)).toBe(false);
        }
        expect(taxonomyNeedsFullRebuild(6, 0)).toBe(true);
    });
});
