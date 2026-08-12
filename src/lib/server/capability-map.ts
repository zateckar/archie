import { db } from './db';
import { getWorkspaceUrl } from './leanix';
import { factsheetUrl } from './leanix-format';
import saCapabilityMap from './data/sa-capability-map.json';
import {
    TECHNOLOGY_TOWERS,
    TECHNICAL_ALIAS_INDEX,
    BUSINESS_ALIAS_INDEX,
    capabilityKey,
    type BusinessPlacement,
    type TechnicalPlacement
} from './capability-taxonomy';

/**
 * Projects the LeanIX portfolio onto two capability frames.
 *
 * Both maps are built at read time from `leanix_relations`, which already holds
 * every edge the sync captured. At this scale (78 factsheets, ~5000 edges, 218
 * business capabilities, 9 towers) that is a few milliseconds of in-memory
 * grouping, so there is no derived table to keep in step with the sync — the map
 * is always exactly as current as the last sync, by construction.
 *
 * The design commitment throughout: a capability name that cannot be placed is
 * REPORTED, never dropped and never guessed into the nearest-looking tile. An
 * architect reading a coverage map has to be able to trust that a full tile means
 * coverage and an empty one means a gap; silently discarding the names that did
 * not match would break exactly that. See `unmapped` on both return types.
 */

// ── Shared shapes ───────────────────────────────────────────────────────────

export interface MappedFactsheet {
    id: string;
    name: string;
    fs_type: string;
    lifecycle_state: string | null;
    url: string | null;
}

export interface CapabilityNode {
    name: string;
    /** Group-model reference from the workbook, where the capability has one. */
    groupRef?: string | null;
    factsheets: MappedFactsheet[];
}

export interface CapabilityGroup {
    name: string;
    capabilities: CapabilityNode[];
    /** Factsheets placed on the group but on no capability beneath it. */
    factsheets: MappedFactsheet[];
    total: number;
}

export interface CapabilityDomain {
    name: string;
    groups: CapabilityGroup[];
    /** Factsheets placed on the domain itself — see the alias table's caveat. */
    factsheets: MappedFactsheet[];
    total: number;
    /** True when the workbook has no level-2/3 detail for this domain. */
    stub: boolean;
}

export interface UnmappedCapability {
    name: string;
    factsheets: MappedFactsheet[];
}

// ── Source rows ─────────────────────────────────────────────────────────────

interface CapabilityEdge {
    capability: string;
    id: string;
    name: string;
    fs_type: string;
    lifecycle_state: string | null;
}

function edgesFor(relType: string): CapabilityEdge[] {
    return db.prepare(`
        SELECT r.to_name AS capability,
               f.id, f.name, f.fs_type, f.lifecycle_state
        FROM leanix_relations r
        JOIN leanix_factsheets f ON f.id = r.from_id
        WHERE r.rel_type = ? AND r.to_name IS NOT NULL AND r.to_name != ''
        ORDER BY f.name COLLATE NOCASE
    `).all(relType) as CapabilityEdge[];
}

function toFactsheet(e: CapabilityEdge, workspace: string): MappedFactsheet {
    return {
        id: e.id,
        name: e.name,
        fs_type: e.fs_type,
        lifecycle_state: e.lifecycle_state,
        url: factsheetUrl({ id: e.id, fs_type: e.fs_type }, workspace)
    };
}

/** Groups edges by capability name, preserving one factsheet entry per id. */
function groupEdges(edges: CapabilityEdge[]): Map<string, { name: string; factsheets: MappedFactsheet[] }> {
    // Resolved once rather than per edge: this runs over thousands of relation
    // rows and the workspace URL is a single app_state read.
    const workspace = getWorkspaceUrl();
    const byName = new Map<string, { name: string; factsheets: MappedFactsheet[]; seen: Set<string> }>();
    for (const e of edges) {
        let entry = byName.get(capabilityKey(e.capability));
        if (!entry) {
            entry = { name: e.capability, factsheets: [], seen: new Set() };
            byName.set(capabilityKey(e.capability), entry);
        }
        if (entry.seen.has(e.id)) continue;
        entry.seen.add(e.id);
        entry.factsheets.push(toFactsheet(e, workspace));
    }
    return byName;
}

// ── Business capability map ─────────────────────────────────────────────────

export interface BusinessCapabilityMap {
    source: string;
    domains: CapabilityDomain[];
    unmapped: UnmappedCapability[];
    stats: {
        domains: number;
        capabilities: number;
        capabilitiesCovered: number;
        referenced: number;
        placed: number;
        unmapped: number;
        stubDomains: number;
    };
}

/**
 * Where a LeanIX business-capability name belongs, if anywhere.
 *
 * Alias table first, then the taxonomy's own names at each level. The taxonomy
 * lookups are what make the alias table shrink rather than grow over time: when
 * the IT/Finance/HR branches are added to the workbook, names that currently need
 * an alias will start matching the map directly.
 */
export function resolveBusinessCapability(
    name: string,
    index: {
        capabilities: Map<string, { domain: string; group: string }>;
        groups: Map<string, { domain: string }>;
        domains: Map<string, string>;
    }
): BusinessPlacement | null {
    const key = capabilityKey(name);

    const alias = BUSINESS_ALIAS_INDEX.get(key);
    if (alias) return alias;

    const cap = index.capabilities.get(key);
    if (cap) return { domain: cap.domain, group: cap.group, capability: name };

    const group = index.groups.get(key);
    if (group) return { domain: group.domain, group: name };

    const domain = index.domains.get(key);
    if (domain) return { domain };

    return null;
}

/** Name → taxonomy-node lookups, one pass over the workbook data. */
export function buildBusinessIndex() {
    const capabilities = new Map<string, { domain: string; group: string }>();
    const groups = new Map<string, { domain: string }>();
    const domains = new Map<string, string>();
    for (const d of saCapabilityMap.domains) {
        domains.set(capabilityKey(d.name), d.name);
        for (const g of d.groups) {
            groups.set(capabilityKey(g.name), { domain: d.name });
            for (const c of g.capabilities) {
                capabilities.set(capabilityKey(c.name), { domain: d.name, group: g.name });
            }
        }
    }
    return { capabilities, groups, domains };
}

/** Name → tower/sub-tower lookups. */
export function buildTechnicalIndex() {
    const subTowers = new Map<string, TechnicalPlacement>();
    const towers = new Map<string, string>();
    for (const t of TECHNOLOGY_TOWERS) {
        towers.set(capabilityKey(t.name), t.name);
        for (const s of t.subTowers) {
            subTowers.set(capabilityKey(s), { tower: t.name, subTower: s });
        }
    }
    return { subTowers, towers };
}

export function getBusinessCapabilityMap(): BusinessCapabilityMap {
    const index = buildBusinessIndex();

    // Build the empty frame first: every domain and capability the workbook
    // knows about is rendered whether or not anything lands on it. The white
    // space is the point — it is what makes a coverage gap visible.
    const domains: CapabilityDomain[] = saCapabilityMap.domains.map(d => ({
        name: d.name,
        stub: d.groups.length === 0,
        factsheets: [],
        total: 0,
        groups: d.groups.map(g => ({
            name: g.name,
            factsheets: [],
            total: 0,
            capabilities: g.capabilities.map(c => ({
                name: c.name,
                groupRef: c.groupRef,
                factsheets: []
            }))
        }))
    }));

    const domainByName = new Map(domains.map(d => [d.name, d]));
    const unmapped: UnmappedCapability[] = [];
    let referenced = 0;
    let placed = 0;

    for (const entry of groupEdges(edgesFor('relApplicationToBusinessCapability')).values()) {
        referenced++;
        const placement = resolveBusinessCapability(entry.name, index);

        const domain = placement ? domainByName.get(placement.domain) : undefined;
        if (!placement || !domain) {
            // Includes an alias pointing at a domain that no longer exists in the
            // workbook — a real possibility after a taxonomy update, and one that
            // must surface rather than silently drop the factsheets.
            unmapped.push({ name: entry.name, factsheets: entry.factsheets });
            continue;
        }
        placed++;

        const group = placement.group ? domain.groups.find(g => g.name === placement.group) : undefined;
        const capability = placement.capability && group
            ? group.capabilities.find(c => c.name === placement.capability)
            : undefined;

        if (capability) capability.factsheets.push(...entry.factsheets);
        else if (group) group.factsheets.push(...entry.factsheets);
        else domain.factsheets.push(...entry.factsheets);
    }

    // Totals count DISTINCT factsheets, not edges: two capabilities in one domain
    // supported by the same application must not make it look like two.
    let capabilities = 0;
    let capabilitiesCovered = 0;
    for (const d of domains) {
        const domainIds = new Set(d.factsheets.map(f => f.id));
        for (const g of d.groups) {
            const groupIds = new Set(g.factsheets.map(f => f.id));
            for (const c of g.capabilities) {
                capabilities++;
                if (c.factsheets.length > 0) capabilitiesCovered++;
                for (const f of c.factsheets) groupIds.add(f.id);
            }
            g.total = groupIds.size;
            for (const id of groupIds) domainIds.add(id);
        }
        d.total = domainIds.size;
    }

    return {
        source: saCapabilityMap.source,
        domains,
        unmapped: unmapped.sort((a, b) => b.factsheets.length - a.factsheets.length || a.name.localeCompare(b.name)),
        stats: {
            domains: domains.length,
            capabilities,
            capabilitiesCovered,
            referenced,
            placed,
            unmapped: unmapped.length,
            stubDomains: domains.filter(d => d.stub).length
        }
    };
}

// ── Technical capability map (TBM Resource Towers) ──────────────────────────

/** A factsheet as drawn in a map cell, with the capabilities that put it there. */
export interface PlacedFactsheet extends MappedFactsheet {
    via: string[];
}

export interface TowerSubTower {
    name: string;
    capabilities: CapabilityNode[];
    /**
     * The cell's contents, each factsheet once.
     *
     * Deduplicated on purpose: a component commonly carries several technology
     * stack values that land in the same sub-tower (SQL Server is tagged both
     * "Databases" and "Relational Database"), and drawing it once per tag makes a
     * map cell look like it has repeated entries — which reads as a bug, not as
     * information. `via` keeps the reason it is there without the repetition.
     */
    factsheets: PlacedFactsheet[];
    total: number;
}

export interface Tower {
    name: string;
    description: string;
    subTowers: TowerSubTower[];
    total: number;
}

export interface TechnicalCapabilityMap {
    towers: Tower[];
    unmapped: UnmappedCapability[];
    stats: {
        towers: number;
        subTowers: number;
        subTowersCovered: number;
        referenced: number;
        placed: number;
        unmapped: number;
    };
}

/** Alias table first, then the tower/sub-tower names themselves. */
export function resolveTechnicalCapability(
    name: string,
    index: { subTowers: Map<string, TechnicalPlacement>; towers: Map<string, string> }
): TechnicalPlacement | null {
    const key = capabilityKey(name);

    const alias = TECHNICAL_ALIAS_INDEX.get(key);
    if (alias) return alias;

    const sub = index.subTowers.get(key);
    if (sub) return sub;

    const tower = index.towers.get(key);
    // A name matching a tower but no sub-tower is placed on the tower's first
    // sub-tower only if there is exactly one; otherwise it is left unmapped
    // rather than arbitrarily assigned.
    if (tower) {
        const t = TECHNOLOGY_TOWERS.find(x => x.name === tower);
        if (t && t.subTowers.length === 1) return { tower: t.name, subTower: t.subTowers[0] };
    }
    return null;
}

export function getTechnicalCapabilityMap(): TechnicalCapabilityMap {
    const index = buildTechnicalIndex();

    const towers: Tower[] = TECHNOLOGY_TOWERS.map(t => ({
        name: t.name,
        description: t.description,
        total: 0,
        subTowers: t.subTowers.map(s => ({ name: s, capabilities: [], factsheets: [], total: 0 }))
    }));
    const towerByName = new Map(towers.map(t => [t.name, t]));

    const unmapped: UnmappedCapability[] = [];
    let referenced = 0;
    let placed = 0;

    for (const entry of groupEdges(edgesFor('relITComponentToTechnologyStack')).values()) {
        referenced++;
        const placement = resolveTechnicalCapability(entry.name, index);
        const tower = placement ? towerByName.get(placement.tower) : undefined;
        const subTower = tower && placement ? tower.subTowers.find(s => s.name === placement.subTower) : undefined;

        if (!subTower) {
            unmapped.push({ name: entry.name, factsheets: entry.factsheets });
            continue;
        }
        placed++;
        subTower.capabilities.push({ name: entry.name, factsheets: entry.factsheets });
    }

    let subTowers = 0;
    let subTowersCovered = 0;
    for (const t of towers) {
        const towerIds = new Set<string>();
        for (const s of t.subTowers) {
            subTowers++;
            s.capabilities.sort((a, b) => b.factsheets.length - a.factsheets.length || a.name.localeCompare(b.name));

            // Collapse the cell to one entry per factsheet, remembering every
            // capability that placed it there.
            const placed = new Map<string, PlacedFactsheet>();
            for (const c of s.capabilities) {
                for (const f of c.factsheets) {
                    const existing = placed.get(f.id);
                    if (existing) {
                        if (!existing.via.includes(c.name)) existing.via.push(c.name);
                    } else {
                        placed.set(f.id, { ...f, via: [c.name] });
                    }
                }
            }
            s.factsheets = [...placed.values()].sort((a, b) => a.name.localeCompare(b.name));
            s.total = s.factsheets.length;
            if (s.total > 0) subTowersCovered++;
            for (const f of s.factsheets) towerIds.add(f.id);
        }
        t.total = towerIds.size;
    }

    return {
        towers,
        unmapped: unmapped.sort((a, b) => b.factsheets.length - a.factsheets.length || a.name.localeCompare(b.name)),
        stats: {
            towers: towers.length,
            subTowers,
            subTowersCovered,
            referenced,
            placed,
            unmapped: unmapped.length
        }
    };
}

// ── Factsheet details for the map's detail panel ────────────────────────────

export interface FactsheetDetail {
    id: string;
    name: string;
    fs_type: string;
    category: string | null;
    lifecycle_state: string | null;
    technical_fit: string | null;
    business_criticality: string | null;
    end_of_life_date: string | null;
    completion: number | null;
    description: string | null;
    vendor: string | null;
    org: string | null;
    capabilities: string | null;
    app_count: number;
    url: string | null;
}

/**
 * Every factsheet, keyed by id, so a tile can open a real detail without a
 * second round trip and without repeating the description text once per
 * capability the factsheet appears under. 78 rows — small enough to send whole.
 */
export function getFactsheetDetails(): Record<string, FactsheetDetail> {
    const rows = db.prepare(`
        SELECT f.id, f.name, f.fs_type, f.category, f.lifecycle_state, f.technical_fit,
               f.business_criticality, f.end_of_life_date, f.completion, f.description,
               (SELECT r.to_name FROM leanix_relations r
                 WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToProvider' LIMIT 1) AS vendor,
               (SELECT r.to_name FROM leanix_relations r
                 WHERE r.from_id = f.id
                   AND r.rel_type IN ('relApplicationToUserGroup', 'relITComponentToUserGroup') LIMIT 1) AS org,
               (SELECT GROUP_CONCAT(r.to_name, ', ') FROM leanix_relations r
                 WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToTechnologyStack') AS capabilities,
               (SELECT COUNT(*) FROM leanix_relations r
                 WHERE r.from_id = f.id AND r.rel_type = 'relITComponentToApplication') AS app_count
        FROM leanix_factsheets f
    `).all() as Omit<FactsheetDetail, 'url'>[];

    const workspace = getWorkspaceUrl();
    const out: Record<string, FactsheetDetail> = {};
    for (const r of rows) {
        out[r.id] = {
            ...r,
            end_of_life_date: r.end_of_life_date ? String(r.end_of_life_date).slice(0, 10) : null,
            url: factsheetUrl({ id: r.id, fs_type: r.fs_type }, workspace)
        };
    }
    return out;
}

export function getCapabilityMaps() {
    return {
        business: getBusinessCapabilityMap(),
        technical: getTechnicalCapabilityMap(),
        details: getFactsheetDetails()
    };
}
