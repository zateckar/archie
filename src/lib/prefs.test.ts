import { describe, it, expect } from 'vitest';
import {
    clampSidebarWidth,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_DEFAULT_WIDTH
} from './prefs';

describe('clampSidebarWidth', () => {
    it('passes an in-range width through, rounded to whole pixels', () => {
        expect(clampSidebarWidth(320)).toBe(320);
        expect(clampSidebarWidth(320.6)).toBe(321);
    });

    it('clamps to the resizable range at both ends', () => {
        expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
        expect(clampSidebarWidth(5000)).toBe(SIDEBAR_MAX_WIDTH);
        expect(clampSidebarWidth(-1)).toBe(SIDEBAR_MIN_WIDTH);
    });

    it('falls back to the default for a value that is not a number', () => {
        // The API feeds this Number(body[key]) straight off the wire, so NaN and
        // Infinity are reachable inputs — they must not reach the width style.
        expect(clampSidebarWidth(Number('nonsense'))).toBe(SIDEBAR_DEFAULT_WIDTH);
        expect(clampSidebarWidth(Infinity)).toBe(SIDEBAR_DEFAULT_WIDTH);
    });

    it('has a default inside its own range', () => {
        expect(SIDEBAR_DEFAULT_WIDTH).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH);
        expect(SIDEBAR_DEFAULT_WIDTH).toBeLessThanOrEqual(SIDEBAR_MAX_WIDTH);
    });
});
