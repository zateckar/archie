import { getPortfolioPage } from '$lib/server/leanix-queries';

/**
 * Loaded entirely from SQLite. Opening this page never contacts LeanIX — the
 * daily sync is the only thing that does (see lib/server/leanix.ts), which is
 * what keeps the integration at two requests a day no matter how many architects
 * are looking at it.
 */
export function load() {
    return getPortfolioPage();
}
