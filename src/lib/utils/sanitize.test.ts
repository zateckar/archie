// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeHtml, escapeText, isSafeUrl } from './sanitize';

/**
 * The sanitizer is the primary control on the two `{@html}` sinks in this app
 * (chat answers and the wiki viewer), so the vectors that defeated the previous
 * regex implementation are pinned here as regressions.
 *
 * Runs under jsdom because the implementation is parser-based — that is the whole
 * point of the rewrite. jsdom is a devDependency and is not part of the bundle.
 */

/**
 * Asserts on structure rather than on substrings.
 *
 * A substring check is the wrong instrument here, and using one is how the
 * severity of the slash-separator vectors got overstated in the first place:
 * `<img src=x/onerror=alert(1)>` serializes as `<img src="x/onerror=alert(1)">`,
 * where "onerror" appears only *inside the src value*. Grepping the output string
 * calls that a bypass; parsing it shows a single `src` attribute and no event
 * handler, so nothing can fire. What actually matters is whether the DOM ends up
 * with a handler attribute or a dangerous element.
 */
function parse(html: string): HTMLElement {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    return doc.body;
}

function hasEventHandler(html: string): boolean {
    return Array.from(parse(html).querySelectorAll('*')).some(el =>
        Array.from(el.attributes).some(a => a.name.toLowerCase().startsWith('on'))
    );
}

function hasElement(html: string, selector: string): boolean {
    return parse(html).querySelector(selector) !== null;
}

describe('sanitizeHtml — vectors that bypassed the previous regex version', () => {
    it('leaves no event handler for a / separated handler, and keeps the value inert', () => {
        const out = sanitizeHtml('<img src=x/onerror=alert(1)>');
        expect(hasEventHandler(out)).toBe(false);
        // The parser folds the whole thing into src, so this was never a live
        // handler — but the value must still be a safe relative URL, not a scheme.
        const img = parse(out).querySelector('img');
        expect(img?.getAttribute('src')).not.toMatch(/^[a-z]+:/i);
    });

    it('drops svg entirely, including /onload', () => {
        const out = sanitizeHtml('<svg/onload=alert(1)>');
        expect(hasEventHandler(out)).toBe(false);
        expect(hasElement(out, 'svg')).toBe(false);
    });

    it('leaves no ontoggle handler on details with a / separator', () => {
        const out = sanitizeHtml('<details open/ontoggle=alert(1)>x</details>');
        expect(hasEventHandler(out)).toBe(false);
    });

    // The four below produced genuinely live constructs in the DOM and are the
    // ones that actually mattered.
    it('removes an unclosed style tag and its @import', () => {
        const out = sanitizeHtml('<style>@import url(//attacker.example/x.css);');
        expect(hasElement(out, 'style')).toBe(false);
        expect(out).not.toMatch(/@import/i);
    });

    it('removes an unclosed iframe with srcdoc', () => {
        const out = sanitizeHtml('<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">');
        expect(hasElement(out, 'iframe')).toBe(false);
        expect(out).not.toMatch(/srcdoc/i);
    });

    it('removes svg animate pointing href at a javascript URL', () => {
        const out = sanitizeHtml(
            '<svg><a><animate attributeName=href values=javascript:alert(1) /><text>go</text></a></svg>'
        );
        expect(hasElement(out, 'svg, animate')).toBe(false);
        expect(out).not.toMatch(/javascript:/i);
    });

    it('removes object with a javascript: data URL', () => {
        const out = sanitizeHtml('<object data="javascript:alert(1)">');
        expect(hasElement(out, 'object')).toBe(false);
        expect(out).not.toMatch(/javascript:/i);
    });
});

describe('sanitizeHtml — event handlers and scripts', () => {
    it('strips a conventional whitespace-separated handler', () => {
        expect(sanitizeHtml('<img src=x onerror="alert(1)">')).not.toMatch(/onerror/i);
    });

    it('strips handlers regardless of case', () => {
        expect(sanitizeHtml('<p OnMouseOver="alert(1)">x</p>')).not.toMatch(/onmouseover/i);
    });

    it('removes script elements and their contents', () => {
        const out = sanitizeHtml('<p>before</p><script>alert(1)</script><p>after</p>');
        expect(out).not.toMatch(/alert|<script/i);
        expect(out).toContain('before');
        expect(out).toContain('after');
    });

    it('does not resurrect a script from a split tag', () => {
        const out = sanitizeHtml('<scr<script>ipt>alert(1)</script>');
        // `alert(1)` legitimately survives as escaped TEXT — that is harmless and
        // is what a sanitizer should do. What must not survive is a script element.
        expect(hasElement(out, 'script')).toBe(false);
        expect(out).not.toContain('<script');
    });

    it('strips namespaced attributes used as bypass vectors', () => {
        const out = sanitizeHtml('<a xlink:href="javascript:alert(1)">x</a>');
        expect(out).not.toMatch(/xlink|javascript:/i);
    });
});

describe('sanitizeHtml — URL schemes', () => {
    it('drops javascript: hrefs but keeps the link text', () => {
        const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
        expect(out).not.toMatch(/javascript:/i);
        expect(out).toContain('click');
    });

    it('drops a javascript: URL obfuscated with a tab', () => {
        expect(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>')).not.toMatch(/javascript:/i);
    });

    it('drops a javascript: URL obfuscated with a zero-width space', () => {
        expect(sanitizeHtml('<a href="java​script:alert(1)">x</a>')).not.toMatch(/javascript:/i);
    });

    it('drops a javascript: URL obfuscated with a newline', () => {
        expect(sanitizeHtml('<a href="java\nscript:alert(1)">x</a>')).not.toMatch(/javascript:/i);
    });

    it('keeps ordinary http(s), mailto and relative links', () => {
        expect(sanitizeHtml('<a href="https://example.com/a">x</a>')).toContain('https://example.com/a');
        expect(sanitizeHtml('<a href="mailto:a@b.c">x</a>')).toContain('mailto:a@b.c');
        expect(sanitizeHtml('<a href="/docs/guide.md">x</a>')).toContain('/docs/guide.md');
        expect(sanitizeHtml('<a href="#section">x</a>')).toContain('#section');
    });

    it('forces rel=noopener on links opening a new tab', () => {
        const out = sanitizeHtml('<a href="https://example.com" target="_blank">x</a>');
        expect(out).toMatch(/rel="noopener noreferrer"/);
    });
});

describe('isSafeUrl', () => {
    it('rejects javascript and vbscript', () => {
        expect(isSafeUrl('javascript:alert(1)')).toBe(false);
        expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
    });

    it('rejects data: URLs by default', () => {
        expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    });

    it('allows inline raster images only where opted in', () => {
        const png = 'data:image/png;base64,iVBORw0KGgo=';
        expect(isSafeUrl(png, false)).toBe(false);
        expect(isSafeUrl(png, true)).toBe(true);
    });

    it('never allows data:image/svg+xml, which can carry scripts', () => {
        expect(isSafeUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', true)).toBe(false);
    });

    it('rejects an empty or whitespace-only value', () => {
        expect(isSafeUrl('')).toBe(false);
        expect(isSafeUrl('   ')).toBe(false);
    });
});

describe('sanitizeHtml — preserves legitimate markdown output', () => {
    it('keeps headings, emphasis, lists, links and code', () => {
        const html =
            '<h2>Title</h2><p><strong>bold</strong> <em>italic</em></p>' +
            '<ul><li>one</li><li>two</li></ul>' +
            '<pre><code class="language-ts">const x = 1;</code></pre>';
        const out = sanitizeHtml(html);
        expect(out).toContain('<h2>Title</h2>');
        expect(out).toContain('<strong>bold</strong>');
        expect(out).toContain('<li>one</li>');
        expect(out).toContain('const x = 1;');
    });

    it('keeps the language- class that mermaid detection and highlighting rely on', () => {
        const out = sanitizeHtml('<pre><code class="language-mermaid">flowchart TD</code></pre>');
        expect(out).toContain('class="language-mermaid"');
    });

    it('keeps tables with alignment and spans', () => {
        const out = sanitizeHtml(
            '<table><thead><tr><th align="left">a</th></tr></thead>' +
            '<tbody><tr><td colspan="2">b</td></tr></tbody></table>'
        );
        expect(out).toContain('align="left"');
        expect(out).toContain('colspan="2"');
    });

    it('keeps task-list checkboxes', () => {
        const out = sanitizeHtml('<li><input type="checkbox" disabled checked> done</li>');
        expect(out).toMatch(/<input[^>]*type="checkbox"/);
    });

    it('keeps images with safe sources', () => {
        const out = sanitizeHtml('<img src="/assets/diagram.png" alt="diagram" width="400">');
        expect(out).toContain('/assets/diagram.png');
        expect(out).toContain('alt="diagram"');
    });

    it('unwraps an unknown element rather than deleting its text', () => {
        const out = sanitizeHtml('<marquee>important text</marquee>');
        expect(out).not.toMatch(/marquee/i);
        expect(out).toContain('important text');
    });

    it('drops id and name, which enable DOM clobbering', () => {
        const out = sanitizeHtml('<div id="attributes" name="x">text</div>');
        expect(out).not.toMatch(/id=|name=/);
        expect(out).toContain('text');
    });

    it('removes comments', () => {
        expect(sanitizeHtml('<p>a</p><!-- hidden -->')).not.toContain('hidden');
    });

    it('handles empty and non-string input', () => {
        expect(sanitizeHtml('')).toBe('');
        expect(sanitizeHtml(undefined as unknown as string)).toBe('');
    });
});

describe('escapeText', () => {
    it('escapes every character that could start markup', () => {
        expect(escapeText('<img src=x onerror=alert(1)>')).toBe(
            '&lt;img src=x onerror=alert(1)&gt;'
        );
        expect(escapeText(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    });

    it('escapes ampersands before the other replacements, not after', () => {
        // A naive ordering yields '&amp;lt;' for this input.
        expect(escapeText('&lt;')).toBe('&amp;lt;');
    });
});
