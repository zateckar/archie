/**
 * HTML sanitizer for use with Svelte's `{@html ...}` directive.
 *
 * ## Why this is parser-based
 *
 * This replaced a regex sanitizer that stripped event handlers with
 * `\s+(?:on\w+)\s*=\s*...`. HTML also accepts `/` as an attribute separator, so
 * `<img src=x/onerror=...>` and `<svg/onload=...>` carried no leading whitespace
 * and went straight through; so did an unclosed `<style>`, an unclosed
 * `<iframe srcdoc=...>`, and `<svg><animate attributeName=href values=javascript:...>`.
 * Measured, 6 of 10 standard vectors survived.
 *
 * Widening the character class would have fixed those six and lost to the
 * seventh. Matching HTML with regular expressions is the wrong shape for the
 * problem: what's needed is the parser's own view of where a tag ends and an
 * attribute begins. So this parses the input into an inert document and walks it,
 * keeping only an explicit allowlist of elements and attributes. Anything not
 * named here is dropped, which makes the failure mode "some formatting was lost"
 * rather than "an attribute we hadn't thought of ran".
 *
 * `DOMParser` does not execute scripts, run event handlers, or fetch subresources
 * for the document it builds, so parsing hostile input here is itself inert.
 *
 * ## Server-side rendering
 *
 * Both call sites populate their content from a client-side `fetch` (chat
 * messages and wiki file contents are both empty at SSR time), so there is no
 * untrusted HTML to sanitize on the server. Rather than rely on that staying
 * true, the no-DOM path fails CLOSED — it escapes everything and returns text.
 * If someone later renders document content during SSR, the visible result is
 * escaped markup they will notice, not HTML that silently skipped sanitization.
 */

/** Elements `marked` can emit, plus the inline formatting we want to keep. */
const ALLOWED_TAGS = new Set([
	'a', 'b', 'blockquote', 'br', 'code', 'col', 'colgroup', 'dd', 'del', 'div',
	'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
	'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody',
	'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var'
]);

/**
 * Elements whose entire subtree is removed rather than unwrapped.
 *
 * Everything else not in ALLOWED_TAGS is unwrapped (children kept) so that an
 * unexpected wrapper doesn't silently delete a paragraph of text. For these, the
 * content itself is the payload, so it goes too.
 *
 * `svg` is included deliberately. Mermaid diagrams are not affected: they are
 * injected into the live DOM by `renderMermaidBlocksIn` after this runs, from
 * mermaid's own renderer at `securityLevel: 'strict'` — they never pass through
 * here. So dropping inline SVG costs nothing and removes a large attack surface
 * (`<animate attributeName=href>`, `<foreignObject>`, scripts inside an SVG
 * document).
 */
const DROP_SUBTREE = new Set([
	'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
	'noscript', 'template', 'title', 'svg', 'math', 'form', 'button',
	'textarea', 'select', 'option', 'frame', 'frameset', 'applet', 'audio',
	'video', 'source', 'track', 'canvas', 'portal'
]);

/**
 * Attributes allowed on any element.
 *
 * `class` is required — code highlighting and mermaid block detection both key
 * off `language-*` classes on `<code>`. It is safe: a class can only reference
 * styles that already exist, not introduce any.
 *
 * `id` and `name` are deliberately absent. Neither is needed for rendered
 * markdown, and both enable DOM clobbering, where an injected element shadows a
 * global that page scripts then read.
 */
const GLOBAL_ATTRS = new Set(['class', 'title', 'dir', 'lang']);

/** Per-element attribute allowlist, merged with GLOBAL_ATTRS. */
const TAG_ATTRS: Record<string, Set<string>> = {
	a: new Set(['href', 'target', 'rel']),
	img: new Set(['src', 'alt', 'width', 'height', 'loading']),
	// marked renders GitHub task lists as a disabled checkbox.
	input: new Set(['type', 'checked', 'disabled']),
	ol: new Set(['start', 'reversed', 'type']),
	td: new Set(['colspan', 'rowspan', 'align']),
	th: new Set(['colspan', 'rowspan', 'align', 'scope']),
	col: new Set(['span']),
	colgroup: new Set(['span'])
};

/** URL schemes permitted in href/src. Everything else — notably `javascript:` — is dropped. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'ftp:']);

/**
 * Characters removed before a URL's scheme is read.
 *
 * C0 controls, space, NBSP, the bidi/zero-width formatting range, and the BOM.
 * Browsers strip all of these while parsing a URL, so `java\tscript:alert(1)` —
 * or the same string with a U+200B between "java" and "script" — still resolves
 * to a javascript URL. A check against the raw attribute value would pass a
 * payload the browser then executes.
 *
 * Written with \u escapes on purpose: the characters this matches are invisible,
 * so spelling them literally would make the one line whose contents matter most
 * impossible to review.
 */
const URL_NOISE = /[\u0000-\u0020\u00A0\u200B-\u200F\u2028\u2029\uFEFF]/g;

/**
 * Escapes text for safe interpolation into an `{@html}` sink.
 *
 * Exported so callers with a "we could not parse this, show it as text" fallback
 * have something safe to fall back TO. The wiki viewer's markdown `catch` used to
 * return the raw document, which handed unparsed HTML straight to `{@html}` —
 * the failure path was less safe than the success path.
 */
export function escapeText(value: string): string {
	if (typeof value !== 'string') return '';
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Internal alias retained for readability at the fail-closed call sites. */
const escapeHtml = escapeText;

/**
 * Whether a URL attribute value is safe to keep.
 *
 * Resolved against a base URL so relative paths (the common case in a wiki) are
 * judged by their resolved scheme rather than by string matching.
 */
export function isSafeUrl(value: string, allowInlineImageData = false): boolean {
	const cleaned = value.replace(URL_NOISE, '');
	if (cleaned === '') return false;

	// Fragment-, query-, and path-relative URLs carry no scheme and are safe.
	if (/^[#/?]/.test(cleaned)) return true;

	if (allowInlineImageData && /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,/i.test(cleaned)) {
		// Inline raster images only. `data:image/svg+xml` is excluded on purpose:
		// an SVG document can carry its own scripts.
		return true;
	}

	let scheme: string;
	try {
		scheme = new URL(cleaned, 'https://sanitizer.invalid/').protocol.toLowerCase();
	} catch {
		return false;
	}

	return SAFE_SCHEMES.has(scheme);
}

/** Replaces `el` with its children, preserving text content. */
function unwrap(el: Element): void {
	const parent = el.parentNode;
	if (!parent) {
		el.remove();
		return;
	}
	while (el.firstChild) parent.insertBefore(el.firstChild, el);
	parent.removeChild(el);
}

function cleanElement(el: Element): void {
	const tag = el.tagName.toLowerCase();

	if (DROP_SUBTREE.has(tag)) {
		el.remove();
		return;
	}

	if (!ALLOWED_TAGS.has(tag)) {
		// Recurse before unwrapping: the children move up to the parent, and they
		// still need cleaning.
		for (const child of Array.from(el.children)) cleanElement(child);
		unwrap(el);
		return;
	}

	const allowed = TAG_ATTRS[tag];
	for (const attr of Array.from(el.attributes)) {
		const name = attr.name.toLowerCase();
		const permitted = GLOBAL_ATTRS.has(name) || (allowed?.has(name) ?? false);

		// Any `on*` handler is rejected regardless of the allowlists above, so a
		// future addition to them cannot accidentally admit one. A namespaced
		// attribute (`xlink:href`, `xmlns:...`) has no legitimate use in this
		// content and is a known bypass vector.
		if (!permitted || name.startsWith('on') || name.includes(':')) {
			el.removeAttribute(attr.name);
			continue;
		}

		if (name === 'href' || name === 'src') {
			if (!isSafeUrl(attr.value, tag === 'img' && name === 'src')) {
				el.removeAttribute(attr.name);
			}
		}
	}

	// A link opening in a new tab gets `rel` set so the opened page cannot reach
	// back through `window.opener`.
	if (tag === 'a' && el.getAttribute('target')) {
		el.setAttribute('rel', 'noopener noreferrer');
	}

	for (const child of Array.from(el.children)) cleanElement(child);
}

export function sanitizeHtml(html: string): string {
	if (typeof html !== 'string' || html === '') return '';

	// Fail closed without a DOM — see the SSR note above.
	if (typeof DOMParser === 'undefined') return escapeHtml(html);

	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
	} catch {
		return escapeHtml(html);
	}

	const body = doc.body;
	if (!body) return escapeHtml(html);

	for (const child of Array.from(body.children)) cleanElement(child);

	// Comments are never meaningful in rendered output and can carry
	// conditional-comment payloads.
	const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
	const comments: Comment[] = [];
	while (walker.nextNode()) comments.push(walker.currentNode as Comment);
	for (const comment of comments) comment.remove();

	return body.innerHTML;
}
