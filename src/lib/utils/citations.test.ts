// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { marked } from 'marked';
import { linkCitations, parseWikiHref, wikiHref } from './citations';
import { sanitizeHtml } from './sanitize';

const SOURCES = [
    { filename: 'integration-rules.md', path: 'technology-portfolio/integration/integration-rules.md', repo_id: 3 },
    { filename: 'backend-development-standards.md', path: 'system-architecture/backend-development-standards.md', repo_id: 3 },
    // An upload: no repository, so no wiki page.
    { filename: 'EA_Integration.md', path: null, repo_id: null },
    { filename: 'ID.FI.005 IT Product shutdown management.md', path: 'id/ID.FI.005 IT Product shutdown management.md', repo_id: 7 }
];

/** The answer as the chat renders it. */
function render(md: string): Document {
    const html = sanitizeHtml(marked.parse(linkCitations(md, SOURCES)) as string);
    return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

describe('linkCitations', () => {
    it('links a cited path to its wiki page, labelled by filename', () => {
        const doc = render('Hlavička je povinná [technology-portfolio/integration/integration-rules.md].');
        const a = doc.querySelector('a.cite')!;
        expect(a.getAttribute('href')).toBe('/wiki/3/technology-portfolio/integration/integration-rules.md');
        expect(a.textContent).toBe('integration-rules.md');
        expect(a.getAttribute('title')).toContain('technology-portfolio/integration/integration-rules.md');
        expect(doc.body.textContent).not.toContain('[');
    });

    it('links each of several adjacent tags', () => {
        const doc = render(
            'Fakt [technology-portfolio/integration/integration-rules.md], [system-architecture/backend-development-standards.md].'
        );
        expect(doc.querySelectorAll('a.cite')).toHaveLength(2);
    });

    it('links a grouped tag only when every part is a source', () => {
        const grouped = render('Fakt [technology-portfolio/integration/integration-rules.md, EA_Integration.md].');
        expect(grouped.querySelectorAll('.cite')).toHaveLength(2);
        const mixed = render('Viz [integration-rules.md, něco jiného].');
        expect(mixed.querySelectorAll('.cite')).toHaveLength(0);
    });

    it('renders a cited upload as a plain chip, not a link', () => {
        const doc = render('Výhradně Škoda IdP [EA_Integration.md].');
        expect(doc.querySelector('a.cite')).toBeNull();
        expect(doc.querySelector('span.cite')?.textContent).toBe('EA_Integration.md');
    });

    it('links a LeanIX factsheet to LeanIX, in a new tab', () => {
        const name = 'LeanIX Application — Fleet Portal.md';
        const url = 'https://vwgroup.leanix.net/Volkswagen/factsheet/Application/abc-123';
        const html = sanitizeHtml(
            marked.parse(linkCitations(`Fakt [${name}].`, [{ filename: name, path: null, repo_id: null, url }])) as string
        );
        const a = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').querySelector('a.cite')!;
        expect(a.getAttribute('href')).toBe(url);
        expect(a.getAttribute('target')).toBe('_blank');
        expect(a.getAttribute('rel')).toBe('noopener noreferrer');
        expect(a.textContent).toBe(name);
    });

    it('prefers the wiki page over an external url, and ignores a non-http url', () => {
        const wiki = linkCitations('[a/b.md]', [{ filename: 'b.md', path: 'a/b.md', repo_id: 1, url: 'https://x.test/' }]);
        expect(wiki).toContain('href="/wiki/1/a/b.md"');
        expect(wiki).not.toContain('_blank');
        const js = linkCitations('[c.md]', [{ filename: 'c.md', path: null, repo_id: null, url: 'javascript:alert(1)' }]);
        expect(js).toContain('<span class="cite"');
        expect(js).not.toContain('javascript');
    });

    it('resolves a tag that uses only the filename of a synced document', () => {
        const doc = render('Fakt [backend-development-standards.md].');
        expect(doc.querySelector('a.cite')?.getAttribute('href')).toBe(
            '/wiki/3/system-architecture/backend-development-standards.md'
        );
    });

    it('encodes path segments, keeping the separators', () => {
        expect(wikiHref(SOURCES[3])).toBe('/wiki/7/id/ID.FI.005%20IT%20Product%20shutdown%20management.md');
        const doc = render('Fakt [id/ID.FI.005 IT Product shutdown management.md].');
        expect(doc.querySelector('a.cite')?.getAttribute('href')).toBe(wikiHref(SOURCES[3]));
    });

    it('parses a wiki link back into the document it names, for Quick View', () => {
        expect(parseWikiHref(wikiHref(SOURCES[3]))).toEqual({
            repoId: 7,
            path: 'id/ID.FI.005 IT Product shutdown management.md'
        });
        expect(parseWikiHref('/wiki/3/a/b.md?highlight=x#top')).toEqual({ repoId: 3, path: 'a/b.md' });
        expect(parseWikiHref('/wiki/3/')).toBeNull();
        expect(parseWikiHref('/wiki/x/a.md')).toBeNull();
        expect(parseWikiHref('https://example.com/wiki/3/a.md')).toBeNull();
        expect(parseWikiHref('/wiki/3/%E0%A4%A.md')).toBeNull();
        expect(parseWikiHref(null)).toBeNull();
    });

    it('leaves a tag that is not one of the sources exactly as written', () => {
        const md = 'Fakt [invented-doc.md] a seznam [x] a [odkaz](https://example.com).';
        expect(linkCitations(md, SOURCES)).toBe(md);
    });

    it('links a tag followed by a colon, but not a reference definition', () => {
        const doc = render('Dvě varianty [system-architecture/backend-development-standards.md]:\n\n* mTLS');
        expect(doc.querySelector('a.cite')?.getAttribute('href')).toBe(
            '/wiki/3/system-architecture/backend-development-standards.md'
        );
        const def = 'Viz [ref].\n\n[EA_Integration.md]: https://example.com\n';
        expect(linkCitations(def, SOURCES)).toBe(def);
    });

    it('does not touch code', () => {
        const md = 'Kód `[EA_Integration.md]` a\n\n```\n[EA_Integration.md]\n```\n';
        expect(linkCitations(md, SOURCES)).toBe(md);
    });

    it('is a no-op without sources', () => {
        expect(linkCitations('Fakt [EA_Integration.md].', [])).toBe('Fakt [EA_Integration.md].');
        expect(linkCitations('Fakt [EA_Integration.md].', undefined)).toBe('Fakt [EA_Integration.md].');
    });

    it('escapes source names it interpolates', () => {
        const hostile = [{ filename: '"><img src=x onerror=alert(1)>.md', path: null, repo_id: null }];
        const out = linkCitations('Fakt ["><img src=x onerror=alert(1)>.md].', hostile);
        expect(out).not.toContain('<img');
    });
});
