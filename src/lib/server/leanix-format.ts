import crypto from 'crypto';

/**
 * Pure shaping logic for LeanIX factsheets: GraphQL node → normalized row,
 * normalized row → the markdown document that gets ingested.
 *
 * Everything here is deliberately free of network and database access so the
 * awkward parts — relation fan-out, half-populated enum fields, lifecycle phase
 * ordering — can be tested without spending a LeanIX request. See ./leanix for
 * the client and the sync.
 */

// ── Shapes returned by the GraphQL API ──────────────────────────────────────
// Only the fields the sync actually asks for. `technicalSuitability` and friends
// are plain enum strings; anything ending in `Rel` is a Relation connection.

export interface LeanixRelationEdge {
    node?: { factSheet?: { id?: string; name?: string; type?: string } | null } | null;
}
export interface LeanixConnection {
    edges?: (LeanixRelationEdge | null)[] | null;
}
export interface LeanixNode {
    id: string;
    type: string;
    name: string;
    displayName?: string | null;
    description?: string | null;
    alias?: string | null;
    level?: number | null;
    updatedAt?: string | null;
    release?: string | null;
    category?: string | null;
    technicalSuitability?: string | null;
    functionalSuitability?: string | null;
    businessCriticality?: string | null;
    dataclass?: string | null;
    lxTimeClassification?: string | null;
    TIMERecommendation?: string | null;
    leanixId?: { externalId?: string | null } | null;
    completion?: { completion?: number | null } | null;
    lifecycle?: { asString?: string | null; phases?: { phase: string; startDate: string | null }[] | null } | null;
    tags?: { id: string; name: string; tagGroup?: { name?: string | null } | null }[] | null;
    documents?: { edges?: ({ node?: { name?: string | null; url?: string | null; documentType?: string | null } | null } | null)[] | null } | null;
    subscriptions?: {
        edges?: ({ node?: { type?: string | null; user?: { displayName?: string | null } | null; roles?: { name?: string | null }[] | null } | null } | null)[] | null;
    } | null;
    [relationField: string]: unknown;
}

export interface LeanixFactsheetRow {
    id: string;
    fs_type: string;
    name: string;
    display_name: string | null;
    alias: string | null;
    description: string | null;
    leanix_id: string | null;
    level: number | null;
    category: string | null;
    release: string | null;
    lifecycle_state: string | null;
    lifecycle_phases: string | null;
    end_of_life_date: string | null;
    technical_fit: string | null;
    functional_fit: string | null;
    business_criticality: string | null;
    data_class: string | null;
    time_classification: string | null;
    time_recommendation: string | null;
    completion: number | null;
    documents: string | null;
    tags: string | null;
    updated_at_remote: string | null;
}

export interface LeanixRelationRow {
    from_id: string;
    rel_type: string;
    to_id: string;
    to_name: string | null;
    to_type: string | null;
}

export interface LeanixSubscriptionRow {
    factsheet_id: string;
    subscription_type: string | null;
    role_name: string | null;
    display_name: string | null;
}

/**
 * How many related factsheets a document names before it switches to a count.
 *
 * The cap is not cosmetic. `relITComponentToApplication` carries ~4500 edges
 * across the synced components and one platform alone accounts for 974 of them;
 * inlining those would turn a 300-character factsheet into a 30KB wall of
 * application names, which then gets semantically chunked and mined for claims.
 * The result would be a knowledge graph that "knows" 974 application names and
 * nothing about the platform. A count plus a sample carries the architecturally
 * meaningful part — *how much* rests on this — in one line.
 *
 * Every edge is still stored in `leanix_relations`, which is what the analytics
 * page counts.
 */
export const RELATION_EXAMPLE_LIMIT = 12;

/** Relation fields read per factsheet type, with the label used in the document. */
export const RELATION_FIELDS: Record<string, string> = {
    relApplicationToBusinessCapability: 'Business capabilities',
    relApplicationToITComponent: 'Built on',
    relApplicationToUserGroup: 'Responsible organisation',
    relApplicationToProcess: 'Processes',
    relApplicationToProject: 'Projects',
    relApplicationTodigitalProduct: 'Digital products',
    relITComponentToProvider: 'Vendor',
    relITComponentToApplication: 'Used by applications',
    relITComponentToTechnologyStack: 'Technology capabilities',
    relITComponentToUserGroup: 'Responsible organisation',
    relITComponentToProject: 'Projects',
    relITComponentTodigitalProduct: 'Digital products',
    relToParent: 'Parent',
    relToChild: 'Children',
    relToPredecessor: 'Predecessor',
    relToSuccessor: 'Successor'
};

/**
 * LeanIX enum values are lowerCamelCase; architects read prose. `phaseOut` →
 * "Phase out", `itPlatform` → "IT platform", `fullyAppropriate` → "Fully
 * appropriate". Acronyms that would otherwise be mangled are special-cased.
 */
const ENUM_OVERRIDES: Record<string, string> = {
    itPlatform: 'IT platform',
    endOfLife: 'End of life',
    phaseIn: 'Phase in',
    phaseOut: 'Phase out'
};

export function humanizeEnum(value: string | null | undefined): string | null {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    if (ENUM_OVERRIDES[trimmed]) return ENUM_OVERRIDES[trimmed];
    const spaced = trimmed.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function text(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s.length > 0 ? s : null;
}

/** Flattens one relation connection into rows. Unknown/!object shapes yield []. */
export function extractRelations(node: LeanixNode): LeanixRelationRow[] {
    const rows: LeanixRelationRow[] = [];
    for (const field of Object.keys(RELATION_FIELDS)) {
        const conn = node[field] as LeanixConnection | undefined;
        for (const edge of conn?.edges ?? []) {
            const fs = edge?.node?.factSheet;
            if (!fs?.id) continue;
            rows.push({
                from_id: node.id,
                rel_type: field,
                to_id: fs.id,
                to_name: text(fs.name),
                to_type: text(fs.type)
            });
        }
    }
    return rows;
}

/**
 * Ownership rows. The API also returns each subscriber's email; it is dropped
 * here rather than stored and later filtered, so there is no copy to leak. A
 * subscription with several roles becomes one row per role, which is what makes
 * "how many factsheets have a Product Manager" a plain COUNT.
 */
export function extractSubscriptions(node: LeanixNode): LeanixSubscriptionRow[] {
    const rows: LeanixSubscriptionRow[] = [];
    const seen = new Set<string>();
    for (const edge of node.subscriptions?.edges ?? []) {
        const sub = edge?.node;
        if (!sub) continue;
        const person = text(sub.user?.displayName);
        const roles = (sub.roles ?? []).map(r => text(r?.name)).filter((r): r is string => !!r);
        const roleList = roles.length > 0 ? roles : [null];
        for (const role of roleList) {
            // The PK spans all four columns and SQLite treats NULLs as distinct
            // in a UNIQUE index, so an unnamed/unroled subscriber could otherwise
            // be inserted repeatedly across syncs.
            const key = `${sub.type ?? ''}|${role ?? ''}|${person ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push({
                factsheet_id: node.id,
                subscription_type: text(sub.type),
                role_name: role,
                display_name: person
            });
        }
    }
    return rows;
}

/** Picks the start date of a named lifecycle phase, when the phase is present. */
function phaseDate(node: LeanixNode, phase: string): string | null {
    const hit = (node.lifecycle?.phases ?? []).find(p => p?.phase === phase);
    return text(hit?.startDate);
}

export function normalizeFactsheet(node: LeanixNode): LeanixFactsheetRow {
    const phases = (node.lifecycle?.phases ?? [])
        .filter(p => p && p.phase)
        .map(p => ({ phase: p.phase, startDate: p.startDate ?? null }));

    const documents = (node.documents?.edges ?? [])
        .map(e => e?.node)
        .filter((d): d is NonNullable<typeof d> => !!d && !!d.url)
        .map(d => ({ name: text(d.name), url: text(d.url), type: text(d.documentType) }));

    const tags = (node.tags ?? [])
        .filter(t => t && t.name)
        .map(t => ({ id: t.id, name: t.name, group: text(t.tagGroup?.name) }));

    return {
        id: node.id,
        fs_type: node.type,
        name: node.name,
        display_name: text(node.displayName),
        alias: text(node.alias),
        description: text(node.description),
        leanix_id: text(node.leanixId?.externalId),
        level: typeof node.level === 'number' ? node.level : null,
        category: text(node.category),
        release: text(node.release),
        lifecycle_state: text(node.lifecycle?.asString),
        lifecycle_phases: phases.length > 0 ? JSON.stringify(phases) : null,
        end_of_life_date: phaseDate(node, 'endOfLife'),
        technical_fit: text(node.technicalSuitability),
        functional_fit: text(node.functionalSuitability),
        business_criticality: text(node.businessCriticality),
        data_class: text(node.dataclass),
        time_classification: text(node.lxTimeClassification),
        time_recommendation: text(node.TIMERecommendation),
        completion: typeof node.completion?.completion === 'number' ? node.completion.completion : null,
        documents: documents.length > 0 ? JSON.stringify(documents) : null,
        tags: tags.length > 0 ? JSON.stringify(tags) : null,
        updated_at_remote: text(node.updatedAt)
    };
}

const TYPE_LABELS: Record<string, string> = {
    Application: 'Application',
    ITComponent: 'IT component'
};

function relationLine(label: string, rels: LeanixRelationRow[]): string | null {
    if (rels.length === 0) return null;
    const names = rels.map(r => r.to_name).filter((n): n is string => !!n);
    if (names.length === 0) return null;
    if (names.length <= RELATION_EXAMPLE_LIMIT) {
        return `- **${label}:** ${names.join(', ')}`;
    }
    const shown = names.slice(0, RELATION_EXAMPLE_LIMIT);
    return `- **${label}:** ${names.length} in total, including ${shown.join(', ')} (and ${names.length - shown.length} more)`;
}

/**
 * The document that gets ingested for one factsheet.
 *
 * Written as already-clean markdown because it *is* already clean — it is
 * generated from structured fields, not scraped. The ingestion path skips the
 * LLM cleaning and summarization phases for it (see `preformatted` in rag.ts),
 * which is both cheaper and safer: a cleaner asked to "remove boilerplate" from
 * a 200-character factsheet has been observed to remove the field structure that
 * is the entire point.
 *
 * Subscriber NAMES are deliberately absent. Roles are included ("Responsible:
 * Product Manager") because the role is architectural information; the person is
 * not, and anything written here becomes retrievable claims about a named
 * individual. The names are still stored in `leanix_subscriptions` for the
 * analytics page, which is a table an architect reads, not a corpus an LLM mines.
 */
export function buildFactsheetMarkdown(
    fs: LeanixFactsheetRow,
    relations: LeanixRelationRow[],
    subscriptions: LeanixSubscriptionRow[] = [],
    /** Workspace base URL, so the document carries a link back to the source. */
    workspaceUrl?: string | null
): string {
    const byType = new Map<string, LeanixRelationRow[]>();
    for (const r of relations) {
        if (!byType.has(r.rel_type)) byType.set(r.rel_type, []);
        byType.get(r.rel_type)!.push(r);
    }

    const typeLabel = TYPE_LABELS[fs.fs_type] ?? fs.fs_type;
    const lines: string[] = [`# ${fs.name}`, ''];

    // A one-line summary sentence up top. Retrieval hits chunks, and a chunk that
    // opens with "X is an IT component (service), lifecycle active" answers most
    // portfolio questions without the reader needing the rest of the document.
    const summaryBits = [
        `**${fs.name}** is a LeanIX ${typeLabel.toLowerCase()} factsheet`,
        fs.category ? `in the ${humanizeEnum(fs.category)} category` : null,
        fs.lifecycle_state ? `with lifecycle state ${humanizeEnum(fs.lifecycle_state)}` : null
    ].filter(Boolean);
    lines.push(summaryBits.join(' ') + '.', '');

    if (fs.description) lines.push(fs.description.trim(), '');

    lines.push('## Portfolio attributes', '');
    const attrs: (string | null)[] = [
        `- **Factsheet type:** ${typeLabel}`,
        fs.alias ? `- **Alias:** ${fs.alias}` : null,
        `- **LeanIX ID:** ${fs.id}`,
        // The link belongs in the document, not only in the UI: a chat answer
        // citing this factsheet should be able to hand the reader the source.
        factsheetUrl(fs, workspaceUrl) ? `- **Open in LeanIX:** ${factsheetUrl(fs, workspaceUrl)}` : null,
        fs.leanix_id && fs.leanix_id !== fs.id ? `- **LeanIX external ID:** ${fs.leanix_id}` : null,
        fs.category ? `- **Category:** ${humanizeEnum(fs.category)}` : null,
        fs.release ? `- **Release:** ${fs.release}` : null,
        fs.lifecycle_state ? `- **Lifecycle state:** ${humanizeEnum(fs.lifecycle_state)}` : null,
        fs.end_of_life_date ? `- **End of life:** ${fs.end_of_life_date.slice(0, 10)}` : null,
        fs.technical_fit ? `- **Technical fit:** ${humanizeEnum(fs.technical_fit)}` : null,
        fs.functional_fit ? `- **Functional fit:** ${humanizeEnum(fs.functional_fit)}` : null,
        fs.business_criticality ? `- **Business criticality:** ${humanizeEnum(fs.business_criticality)}` : null,
        fs.data_class ? `- **Data classification:** ${humanizeEnum(fs.data_class)}` : null,
        fs.time_classification ? `- **TIME classification:** ${humanizeEnum(fs.time_classification)}` : null,
        fs.time_recommendation ? `- **TIME recommendation:** ${humanizeEnum(fs.time_recommendation)}` : null
    ];
    lines.push(...attrs.filter((a): a is string => !!a));

    // Lifecycle phases as a dated roadmap — the reason `endOfLife` is worth
    // carrying at all is that "when does this expire" is a portfolio question.
    const phases: { phase: string; startDate: string | null }[] = fs.lifecycle_phases
        ? JSON.parse(fs.lifecycle_phases)
        : [];
    if (phases.length > 0) {
        const rendered = phases
            .map(p => `${humanizeEnum(p.phase)}${p.startDate ? ` from ${p.startDate.slice(0, 10)}` : ''}`)
            .join('; ');
        lines.push(`- **Lifecycle roadmap:** ${rendered}`);
    }

    const responsibleRoles = [
        ...new Set(
            subscriptions
                .filter(s => (s.subscription_type ?? '').toUpperCase() === 'RESPONSIBLE' && s.role_name)
                .map(s => s.role_name as string)
        )
    ];
    if (responsibleRoles.length > 0) {
        lines.push(`- **Responsible roles:** ${responsibleRoles.join(', ')}`);
    }

    const tags: { name: string; group: string | null }[] = fs.tags ? JSON.parse(fs.tags) : [];
    if (tags.length > 0) {
        lines.push(`- **Tags:** ${tags.map(t => (t.group ? `${t.group}: ${t.name}` : t.name)).join(', ')}`);
    }
    if (typeof fs.completion === 'number') {
        lines.push(`- **Factsheet completeness:** ${Math.round(fs.completion * 100)}%`);
    }
    lines.push('');

    const relationLines = Object.entries(RELATION_FIELDS)
        .map(([field, label]) => relationLine(label, byType.get(field) ?? []))
        .filter((l): l is string => !!l);
    if (relationLines.length > 0) {
        lines.push('## Architecture context', '', ...relationLines, '');
    }

    const docs: { name: string | null; url: string | null }[] = fs.documents ? JSON.parse(fs.documents) : [];
    if (docs.length > 0) {
        lines.push('## Linked documentation', '');
        for (const d of docs) lines.push(`- ${d.name ?? d.url}${d.name && d.url ? ` — ${d.url}` : ''}`);
        lines.push('');
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * Identity of a factsheet's *ingested* state.
 *
 * Hashing the rendered markdown rather than the raw API node is what makes the
 * daily sync cheap: a factsheet whose `updatedAt` moved because someone edited a
 * field this integration does not read produces the same markdown, the same
 * hash, and no re-ingestion — no chunking, no embedding, no extraction.
 */
export function factsheetContentHash(markdown: string): string {
    return crypto.createHash('sha256').update(markdown).digest('hex');
}

/** Filename shown on a chat citation. Stable across syncs (id, not name). */
export function factsheetFilename(fs: { fs_type: string; name: string }): string {
    const safe = fs.name.replace(/[\\/:*?"<>|]/g, '-').trim();
    return `LeanIX ${fs.fs_type} — ${safe}.md`;
}

/**
 * Deep link into LeanIX, when the workspace URL is configured. Returns null
 * otherwise: the .env holds an API gateway address, which is not the address a
 * browser opens, and guessing one produces links that 404.
 */
// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * The phases that mean a factsheet is on its way out, earliest-acting first.
 *
 * `phaseOut` outranks `endOfLife` because it is the one that starts the work:
 * once a platform is phasing out, migration is already the answer, and waiting
 * for the end-of-life date is waiting for the deadline rather than the trigger.
 */
export const ENDING_PHASES = ['phaseOut', 'endOfLife'] as const;

export interface LifecyclePhase {
    phase: string;
    startDate: string;
}

export interface EndingMilestone {
    /** YYYY-MM-DD. */
    date: string;
    kind: (typeof ENDING_PHASES)[number];
    label: string;
}

/** Reads the stored `lifecycle_phases` JSON, treating unusable data as absent. */
export function parseLifecyclePhases(raw: unknown): LifecyclePhase[] {
    if (typeof raw !== 'string' || !raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (p): p is LifecyclePhase =>
                !!p && typeof p.phase === 'string' && typeof p.startDate === 'string' && p.startDate.length >= 10
        );
    } catch {
        return [];
    }
}

/**
 * The ending a factsheet is actually working towards, and what kind it is.
 *
 * Reads the lifecycle phases as well as the `end_of_life_date` column and takes
 * the EARLIEST of them, which is the correction this function exists for. The
 * column alone was wrong in both directions on the reference workspace: it is
 * unset on five factsheets that do carry a dated phase-out — Central Log Archive
 * ends 2027-12-31 and appeared on no timeline at all — and where both exist it
 * is routinely the LATER date, so the roadmap presented DevOps Server as a 2030
 * problem when its phase-out had already begun in October 2025.
 *
 * Returns null when nothing dates an ending, which is most of a portfolio.
 */
export function endingMilestone(row: {
    end_of_life_date?: string | null;
    lifecycle_phases?: string | null;
}): EndingMilestone | null {
    const candidates: { date: string; kind: (typeof ENDING_PHASES)[number] }[] = [];

    for (const phase of parseLifecyclePhases(row.lifecycle_phases)) {
        const kind = ENDING_PHASES.find(p => p === phase.phase);
        if (kind) candidates.push({ date: phase.startDate.slice(0, 10), kind });
    }
    if (row.end_of_life_date) {
        candidates.push({ date: String(row.end_of_life_date).slice(0, 10), kind: 'endOfLife' });
    }
    if (candidates.length === 0) return null;

    // Dates are zero-padded ISO, so a string compare is a date compare. On a tie
    // phaseOut wins, being the phase that starts the work.
    candidates.sort((a, b) =>
        a.date.localeCompare(b.date) || ENDING_PHASES.indexOf(a.kind) - ENDING_PHASES.indexOf(b.kind)
    );

    const best = candidates[0];
    return { ...best, label: best.kind === 'phaseOut' ? 'Phase-out' : 'End of life' };
}

export function factsheetUrl(fs: { id: string; fs_type: string }, workspaceUrl?: string | null): string | null {
    const base = (workspaceUrl ?? '').trim().replace(/\/$/, '');
    if (!base) return null;
    return `${base}/factsheet/${fs.fs_type}/${fs.id}`;
}
