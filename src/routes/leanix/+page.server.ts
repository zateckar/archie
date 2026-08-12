import { getPortfolioPage } from '$lib/server/leanix-queries';
import { getMarketPage } from '$lib/server/market-queries';

/**
 * Loaded entirely from SQLite. Opening this page never contacts LeanIX and never
 * runs a web search — the daily sync and the scheduled research run are the only
 * things that do (see lib/server/leanix.ts and lib/server/market-research.ts),
 * which is what keeps both integrations at a fixed cost per day no matter how
 * many architects are looking at the page.
 *
 * Market research is merged in here rather than inside getPortfolioPage so the
 * portfolio stays whole without it: it is an optional datasource that can be
 * switched off, and every one of its fields degrades to empty.
 */
export function load() {
    return {
        ...getPortfolioPage(),
        market: getMarketPage()
    };
}
