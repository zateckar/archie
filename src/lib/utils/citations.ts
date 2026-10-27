import { escapeText } from './sanitize';

/** What a chat answer's `sources` entries carry. Only these fields are read. */
export type CitableSource = {
    filename?: string | null;
    path?: string | null;
    repo_id?: number | string | null;
    /** External page, set server-side for a document with no wiki page (a LeanIX factsheet). */
    url?: string | null;
};

type Citation = { full: string; href: string | null; external: boolean };

/**
 * Wiki URL for a cited source, or null when there is no page to open.
 *
 * Both halves are required: `repo_id` identifies the repository the wiki route
 * is scoped to, and `path` is the file within it. A document uploaded directly
 * (rather than synced from a repository) has no repo_id and no wiki page, so
 * its citation stays plain text instead of becoming a link to nowhere.
 *
 * Segments are encoded individually so the separators survive — this corpus
 * has filenames with spaces ("ID.FI.005 IT Product shutdown management.md"),
 * which `encodeURIComponent` on the whole path would turn into %2F-mangled
 * nonsense. Same construction as SourceResultsPanel's deep link.
 */
export function wikiHref(source: CitableSource | null | undefined): string | null {
    const repoId = source?.repo_id;
    const path = source?.path;
    if (repoId == null || typeof path !== 'string' || path === '') return null;
    return `/wiki/${repoId}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function basename(p: string): string {
    return p.slice(p.lastIndexOf('/') + 1);
}

/**
 * Index of the sources an answer may cite, keyed by every name the model could
 * use for one: the tag it was shown (`path || filename`, see rag.ts and
 * chat-pipeline.ts), the bare filename, and the path's last segment. An entry
 * with a link wins over one without, since the same document can arrive both
 * ways when a second retrieval pass merges in extra chunks.
 *
 * The wiki page is preferred; `url` is the fallback for documents that have
 * none. Only an http(s) `url` is used.
 */
function indexSources(sources: CitableSource[]): Map<string, Citation> {
    const byKey = new Map<string, Citation>();
    for (const source of sources) {
        const full = source?.path || source?.filename;
        if (typeof full !== 'string' || full === '') continue;
        const wiki = wikiHref(source);
        const url = typeof source.url === 'string' && /^https?:\/\//i.test(source.url) ? source.url : null;
        const entry: Citation = { full, href: wiki ?? url, external: !wiki && !!url };
        for (const key of [full, source.filename, basename(full)]) {
            if (typeof key !== 'string' || key === '') continue;
            const existing = byKey.get(key);
            if (existing && (existing.href || !entry.href)) continue;
            byKey.set(key, entry);
        }
    }
    return byKey;
}

/**
 * Code is left alone (a `[x]` in a snippet is not a citation), and a bracket
 * already followed by `(` or `[` is markdown link syntax, not a tag. A tag
 * followed by `:` is a citation ("…two variants [doc.md]:") unless it opens
 * its line, where it is a reference definition — see `isReferenceDefinition`.
 */
const CODE_OR_TAG = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)|\[([^\[\]\n]+)\](?![(\[])/g;

/** `[label]: url` at the start of a line (up to three spaces of indent). */
function isReferenceDefinition(text: string, start: number, end: number): boolean {
    if (text[end] !== ':') return false;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    return /^ {0,3}$/.test(text.slice(lineStart, start));
}

/**
 * Turns the answer's inline `[source]` tags into links to the cited document.
 *
 * Only a tag naming one of the answer's own sources is touched, so ordinary
 * brackets — and a tag the model invented — stay exactly as written: an
 * unverifiable citation should look unverifiable, not become a confident chip.
 * A cited document with no wiki page becomes a plain (non-link) chip.
 *
 * Emits inline HTML, which `marked` passes through and `sanitizeHtml` keeps
 * (`a` with href/class/title). Every interpolated value is escaped.
 */
export function linkCitations(markdown: string, sources: CitableSource[] | null | undefined): string {
    if (!markdown || !sources || sources.length === 0) return markdown;
    const byKey = indexSources(sources);
    if (byKey.size === 0) return markdown;

    return markdown.replace(CODE_OR_TAG, (match, code: string | undefined, tag: string | undefined, offset: number) => {
        if (code !== undefined || tag === undefined) return match;
        if (isReferenceDefinition(markdown, offset, offset + match.length)) return match;
        const whole = byKey.get(tag.trim());
        if (whole) return citation(whole);
        // A grouped tag, "[a.md, b.md]": linked only if every part is a source,
        // so a sentence in brackets that happens to name one stays prose.
        const parts = tag.split(/\s*[,;]\s*/).filter(Boolean);
        if (parts.length < 2) return match;
        const entries = parts.map(p => byKey.get(p));
        if (entries.some(e => !e)) return match;
        return entries.map(e => citation(e!)).join(' ');
    });
}

function citation(entry: Citation): string {
    const label = escapeText(basename(entry.full));
    const full = escapeText(entry.full);
    if (!entry.href) {
        return `<span class="cite" title="${full} — no page to open for this document">${label}</span>`;
    }
    const href = escapeText(entry.href);
    if (entry.external) {
        return `<a class="cite" href="${href}" target="_blank" rel="noopener noreferrer" title="Open ${full} in LeanIX">${label}</a>`;
    }
    return `<a class="cite" href="${href}" title="Open ${full} in the wiki">${label}</a>`;
}
