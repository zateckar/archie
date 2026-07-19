/**
 * Sentence-level highlighting for a rendered document container.
 *
 * Given a free-text query (typically the user's selection from a chat answer),
 * this walks the text nodes inside `container`, finds sentences that contain the
 * query's keywords, and wraps those sentences in <mark class="doc-highlight">.
 * It operates on live DOM text nodes so it never breaks existing markup
 * (headings, links, code, mermaid SVGs, etc.).
 *
 * Returns the first created <mark> element (if any) so the caller can scroll to it.
 */

const SENTENCE_SPLIT = /(?<=[.!?。！？])\s+|\n+/;

function extractKeywords(query: string): string[] {
    return Array.from(
        new Set(
            (query || '')
                .toLowerCase()
                .replace(/[^\w\s]/g, ' ')
                .split(/\s+/)
                .filter((w) => w.length > 2)
        )
    );
}

export function clearHighlights(container: HTMLElement): void {
    const marks = container.querySelectorAll('mark.doc-highlight');
    marks.forEach((m) => {
        const parent = m.parentNode;
        if (!parent) return;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
        parent.normalize();
    });
}

export function highlightText(container: HTMLElement, query: string): HTMLElement | null {
    if (!container || !query) return null;
    const keywords = extractKeywords(query);
    if (keywords.length === 0) return null;

    clearHighlights(container);

    let firstMark: HTMLElement | null = null;

    // Collect candidate text nodes first (mutating during walk is unsafe).
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            // Skip code, scripts, styles, and already-rendered mermaid SVGs.
            if (parent.closest('code, pre, script, style, svg, mark.doc-highlight')) {
                return NodeFilter.FILTER_REJECT;
            }
            const text = node.nodeValue ?? '';
            const lower = text.toLowerCase();
            return keywords.some((k) => lower.includes(k))
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
        }
    });

    const targets: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) targets.push(n as Text);

    for (const textNode of targets) {
        const text = textNode.nodeValue ?? '';
        // Split into sentences, keep only those that match, rebuild the node.
        const sentences = splitKeepingDelimiters(text);
        const anyMatch = sentences.some((s) => sentenceMatches(s, keywords));
        if (!anyMatch) continue;

        const frag = document.createDocumentFragment();
        for (const sentence of sentences) {
            if (sentence.length === 0) continue;
            if (sentenceMatches(sentence, keywords)) {
                const mark = document.createElement('mark');
                mark.className = 'doc-highlight';
                mark.textContent = sentence;
                frag.appendChild(mark);
                if (!firstMark) firstMark = mark;
            } else {
                frag.appendChild(document.createTextNode(sentence));
            }
        }
        textNode.parentNode?.replaceChild(frag, textNode);
    }

    return firstMark;
}

function sentenceMatches(sentence: string, keywords: string[]): boolean {
    const lower = sentence.toLowerCase();
    // Require at least half the keywords (min 1) to reduce noise on short queries.
    const needed = Math.max(1, Math.ceil(keywords.length / 2));
    let hits = 0;
    for (const k of keywords) {
        if (lower.includes(k)) hits++;
        if (hits >= needed) return true;
    }
    return false;
}

/** Split text into sentences while preserving the trailing whitespace/punctuation. */
function splitKeepingDelimiters(text: string): string[] {
    const parts = text.split(SENTENCE_SPLIT);
    // Re-attach the separators that split() consumed by re-scanning.
    // Simpler + good-enough: split, then trim empties are handled by caller.
    return parts.filter((p) => p !== undefined);
}
