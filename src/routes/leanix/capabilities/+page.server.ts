import { getCapabilityMaps } from '$lib/server/capability-map';
import { leanixStatus } from '$lib/server/leanix';

/**
 * Both maps are built from SQLite on each load — a few milliseconds at this
 * scale, and no LeanIX request. See lib/server/capability-map.ts.
 */
export function load() {
    return { ...getCapabilityMaps(), status: leanixStatus() };
}
