import { describe, it, expect } from 'vitest';
import {
    capabilityKey,
    TECHNOLOGY_TOWERS,
    TECHNICAL_CAPABILITY_ALIASES,
    BUSINESS_CAPABILITY_ALIASES
} from './capability-taxonomy';
import {
    buildBusinessIndex,
    buildTechnicalIndex,
    resolveBusinessCapability,
    resolveTechnicalCapability
} from './capability-map';
import saCapabilityMap from './data/sa-capability-map.json';

describe('capabilityKey', () => {
    it('folds the ways a hand-typed capability name drifts', () => {
        expect(capabilityKey('No-Code / Low-Code Application Development'))
            .toBe(capabilityKey('no code low code application development'));
        expect(capabilityKey('  Data   Analytics ')).toBe('data analytics');
        expect(capabilityKey('E-Mail')).toBe('e mail');
    });

    it('folds diacritics so a Czech spelling matches its ASCII twin', () => {
        expect(capabilityKey('Řízení')).toBe(capabilityKey('Rizeni'));
    });

    it('treats missing names as the empty key rather than throwing', () => {
        expect(capabilityKey(null)).toBe('');
        expect(capabilityKey(undefined)).toBe('');
    });
});

/**
 * The alias tables are hand-maintained, so the likeliest defect in this whole
 * feature is a typo pointing at a tower, domain or capability that does not
 * exist — which would silently send factsheets to the unmapped panel while
 * looking perfectly reasonable in review. These two tests make that a build
 * failure instead.
 */
describe('alias table integrity', () => {
    it('every technical alias points at a real tower and sub-tower', () => {
        const valid = new Set(TECHNOLOGY_TOWERS.flatMap(t => t.subTowers.map(s => `${t.name}::${s}`)));
        const broken = Object.entries(TECHNICAL_CAPABILITY_ALIASES)
            .filter(([, p]) => !valid.has(`${p.tower}::${p.subTower}`))
            .map(([name, p]) => `${name} -> ${p.tower} / ${p.subTower}`);
        expect(broken).toEqual([]);
    });

    it('every business alias points at a real domain, group and capability', () => {
        const index = buildBusinessIndex();
        const broken: string[] = [];
        for (const [name, p] of Object.entries(BUSINESS_CAPABILITY_ALIASES)) {
            const domain = saCapabilityMap.domains.find(d => d.name === p.domain);
            if (!domain) {
                broken.push(`${name}: unknown domain "${p.domain}"`);
                continue;
            }
            if (p.group) {
                const group = domain.groups.find(g => g.name === p.group);
                if (!group) {
                    broken.push(`${name}: unknown group "${p.group}" in "${p.domain}"`);
                    continue;
                }
                if (p.capability && !group.capabilities.some(c => c.name === p.capability)) {
                    broken.push(`${name}: unknown capability "${p.capability}" in "${p.group}"`);
                }
            } else if (p.capability) {
                broken.push(`${name}: capability "${p.capability}" given without a group`);
            }
        }
        expect(broken).toEqual([]);
        expect(index.domains.size).toBeGreaterThan(0);
    });

    it('no alias name is defined twice under different spellings', () => {
        const seen = new Map<string, string>();
        const clashes: string[] = [];
        for (const name of Object.keys(BUSINESS_CAPABILITY_ALIASES)) {
            const key = capabilityKey(name);
            if (seen.has(key)) clashes.push(`${name} vs ${seen.get(key)}`);
            seen.set(key, name);
        }
        expect(clashes).toEqual([]);
    });
});

describe('the technology tower model', () => {
    /**
     * The property the towers were restructured to have: one axis, no tower
     * acting as the platform layer of another. These two tests are what stop it
     * drifting back — the previous model put virtualization and containers under
     * Compute but databases under a separate "Platform" tower, so Compute owned
     * its full execution stack while Storage owned only raw capacity.
     */
    it('keeps the execution stack and the persistence stack symmetric', () => {
        const compute = TECHNOLOGY_TOWERS.find(t => t.name === 'Compute')!;
        const data = TECHNOLOGY_TOWERS.find(t => t.name === 'Data & Storage')!;

        // Compute owns raw capacity AND the abstractions layered on it.
        expect(compute.subTowers).toContain('Servers & Virtualization');
        expect(compute.subTowers).toContain('Containers & Orchestration');
        expect(compute.subTowers).toContain('Runtime & Execution Environments');

        // Data & Storage owns exactly the same shape for persistence: a database
        // is to storage what a container platform is to a server.
        expect(data.subTowers).toContain('Block, File & Object Storage');
        expect(data.subTowers).toContain('Database Platforms');
        expect(data.subTowers).toContain('Caching & In-Memory Data');
    });

    it('has no catch-all "platform" tower standing in for other towers', () => {
        expect(TECHNOLOGY_TOWERS.map(t => t.name)).not.toContain('Platform');
    });

    it('gives every sub-tower a name unique across all towers', () => {
        // Sub-tower names are matchable directly (see resolveTechnicalCapability),
        // so a duplicate would make a name resolve to whichever tower happened to
        // be indexed last.
        const seen = new Map<string, string>();
        const clashes: string[] = [];
        for (const tower of TECHNOLOGY_TOWERS) {
            for (const sub of tower.subTowers) {
                const key = capabilityKey(sub);
                if (seen.has(key)) clashes.push(`${sub}: ${tower.name} vs ${seen.get(key)}`);
                seen.set(key, tower.name);
            }
        }
        expect(clashes).toEqual([]);
    });
});

describe('resolveTechnicalCapability', () => {
    const index = buildTechnicalIndex();
    const resolve = (name: string) => resolveTechnicalCapability(name, index);

    it('places a name from the alias table', () => {
        expect(resolve('Relational Database')).toEqual({ tower: 'Data & Storage', subTower: 'Database Platforms' });
        expect(resolve('Web Application Firewall'))
            .toEqual({ tower: 'Security & Identity', subTower: 'Perimeter & Application Security' });
    });

    it('puts the whole execution stack in Compute', () => {
        for (const name of ['Compute', 'Virtualization', 'Containers', 'Container Orchestration', 'Execution & Runtime Environment']) {
            expect(resolve(name)?.tower).toBe('Compute');
        }
    });

    it('puts the whole persistence stack in Data & Storage', () => {
        for (const name of ['Storage', 'Databases', 'Relational Database', 'Document Database', 'NoSQL Database', 'In-Memory Cache']) {
            expect(resolve(name)?.tower).toBe('Data & Storage');
        }
    });

    it('matches a sub-tower by its own name, with no alias needed', () => {
        expect(resolve('API Management')).toEqual({ tower: 'Integration & APIs', subTower: 'API Management' });
        expect(resolve('backup & archive')).toEqual({ tower: 'Data & Storage', subTower: 'Backup & Archive' });
    });

    it('refuses to place a bare tower name that has several sub-towers', () => {
        // "Data & Storage" alone says nothing about WHICH persistence service,
        // and picking the first sub-tower would invent coverage never stated.
        expect(resolve('Data & Storage')).toBeNull();
        expect(resolve('Security & Compliance')).toEqual({
            // ...but this one is in the alias table explicitly, so it resolves.
            tower: 'Security & Identity',
            subTower: 'Security Operations'
        });
    });

    it('returns null for an unknown name rather than guessing', () => {
        expect(resolve('Quantum Teleportation')).toBeNull();
        expect(resolve('')).toBeNull();
    });
});

describe('resolveBusinessCapability', () => {
    const index = buildBusinessIndex();
    const resolve = (name: string) => resolveBusinessCapability(name, index);

    it('places a LeanIX name via the alias table', () => {
        expect(resolve('Fixed Assets Closing')).toEqual({ domain: 'Finance' });
        expect(resolve('Enterprise Architecture Management')).toEqual({ domain: 'IT' });
    });

    it('matches a level-3 capability straight out of the workbook', () => {
        const domain = saCapabilityMap.domains.find(d => d.groups.length > 0)!;
        const group = domain.groups[0];
        const capability = group.capabilities[0];
        expect(resolve(capability.name)).toEqual({
            domain: domain.name,
            group: group.name,
            capability: capability.name
        });
    });

    it('matches a level-2 group by name', () => {
        const domain = saCapabilityMap.domains.find(d => d.groups.length > 0)!;
        expect(resolve(domain.groups[0].name)).toEqual({
            domain: domain.name,
            group: domain.groups[0].name
        });
    });

    it('matches a level-1 domain by name', () => {
        // Picked deliberately: the workbook has domains whose name is ALSO a group
        // name beneath them ("Marketing" / "Marketing"), and for those the group
        // match wins, which is the correct precedence — more specific first.
        const domain = saCapabilityMap.domains.find(
            d => !saCapabilityMap.domains.some(o => o.groups.some(g => g.name === d.name))
        )!;
        expect(resolve(domain.name)).toEqual({ domain: domain.name });
    });

    it('prefers the more specific node when a name exists at two levels', () => {
        const ambiguous = saCapabilityMap.domains.find(d => d.groups.some(g => g.name === d.name));
        if (!ambiguous) return;
        expect(resolve(ambiguous.name)).toEqual({ domain: ambiguous.name, group: ambiguous.name });
    });

    it('lets the alias table win over a taxonomy name match', () => {
        // Aliases exist to correct the taxonomy's own naming, so they must be
        // consulted first or a correction could never take effect.
        const aliased = Object.keys(BUSINESS_CAPABILITY_ALIASES)[0];
        expect(resolve(aliased)).toEqual(BUSINESS_CAPABILITY_ALIASES[aliased]);
    });

    it('returns null for a name in neither the aliases nor the workbook', () => {
        expect(resolve('Warp Core Maintenance')).toBeNull();
    });
});

describe('the workbook data itself', () => {
    it('carries the domains the map is drawn from', () => {
        expect(saCapabilityMap.domains.length).toBeGreaterThanOrEqual(17);
        const total = saCapabilityMap.domains
            .flatMap(d => d.groups)
            .reduce((n, g) => n + g.capabilities.length, 0);
        expect(total).toBeGreaterThan(200);
    });

    it('still records the level-1 stubs, which the map renders as gaps', () => {
        // These are the domains the Enterprise-tagged factsheets actually sit in.
        // If a future workbook fills them, this expectation is the reminder to
        // deepen BUSINESS_CAPABILITY_ALIASES from domain to capability level.
        const stubs = saCapabilityMap.domains.filter(d => d.groups.length === 0).map(d => d.name);
        expect(stubs).toContain('IT');
        expect(stubs).toContain('Finance');
    });
});
