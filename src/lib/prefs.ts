/**
 * Shared UI-preference keys and bounds.
 *
 * Lives outside `$lib/server` because the client clamps the recents panel while
 * dragging and the API clamps it again on save — both must use the same numbers
 * or a width that looks legal in the browser gets silently rewritten on reload.
 */
export const SIDEBAR_WIDTH_KEY = 'sidebarWidth';

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 288; // matches the previous fixed w-72

/** Rounds to whole pixels and clamps into the resizable range. */
export function clampSidebarWidth(width: number): number {
    if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}
