/**
 * Post-processes rendered markdown HTML to replace fenced mermaid code blocks
 * with rendered SVG diagrams.
 *
 * Used by chat messages and wiki view pages. Operates directly on the DOM after
 * `{@html}` injects the parsed-markdown HTML — this bypasses the HTML sanitizer
 * for the SVG output (mermaid SVGs embed <style> which the sanitizer would strip).
 *
 * Idempotent: re-running on the same container will skip already-rendered blocks.
 */

import { renderMermaid, hashId } from './mermaid';
import { openMermaidFullscreen } from '$lib/stores/mermaidFullscreen';

const RENDERED_ATTR = 'data-mermaid-rendered';

/**
 * Find every `pre > code.language-mermaid` block inside `container` and replace
 * its parent <pre> with a rendered diagram wrapper.
 */
export async function renderMermaidBlocksIn(container: HTMLElement): Promise<void> {
    if (!container) return;
    // Capture nodes up front since we'll be mutating the tree.
    const codeBlocks = Array.from(
        container.querySelectorAll<HTMLElement>('code.language-mermaid')
    );

    for (const code of codeBlocks) {
        const pre = code.parentElement;
        if (!pre || pre.tagName !== 'PRE') continue;
        if (pre.getAttribute(RENDERED_ATTR) === '1') continue;

        // Mark immediately to prevent re-processing during await.
        pre.setAttribute(RENDERED_ATTR, '1');

        const source = code.textContent || '';
        const id = hashId(source);
        const result = await renderMermaid(source, id);

        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid-diagram-wrapper';
        wrapper.setAttribute('data-mermaid-source', source);

        if (result.ok) {
            // Diagrams can render very tall (e.g. long flowcharts); constrain them to a
            // scrollable box so a single diagram can't dominate the chat window. The full
            // diagram remains available via the "Expand" button's zoom/pan fullscreen view.
            const scroll = document.createElement('div');
            scroll.className = 'mermaid-diagram-scroll';
            scroll.innerHTML = result.svg;
            const svgEl = scroll.querySelector('svg');
            if (svgEl) {
                svgEl.setAttribute('role', 'img');
                svgEl.setAttribute('aria-label', 'Mermaid diagram');
                // Let the SVG be responsive within its container.
                svgEl.removeAttribute('height');
                svgEl.style.maxWidth = '100%';
                svgEl.style.height = 'auto';
            }
            wrapper.appendChild(scroll);

            // Toolbar: copy source, toggle source view, expand to fullscreen zoom/pan viewer.
            const toolbar = document.createElement('div');
            toolbar.className = 'mermaid-diagram-toolbar';
            toolbar.innerHTML = `
                <button type="button" class="mermaid-btn" data-action="copy" title="Copy source">Copy</button>
                <button type="button" class="mermaid-btn" data-action="source" title="View source">Source</button>
                <button type="button" class="mermaid-btn" data-action="expand" title="View fullscreen">Expand</button>
            `;
            wrapper.appendChild(toolbar);
            wireToolbar(wrapper, source, result.svg);
        } else {
            wrapper.classList.add('mermaid-diagram-error');
            const errMsg = escapeHtml(result.error);
            const safeSrc = escapeHtml(source);
            wrapper.innerHTML = `
                <p class="mermaid-error-title">Diagram syntax error</p>
                <pre class="mermaid-error-msg">${errMsg}</pre>
                <details class="mermaid-error-details">
                    <summary>View source</summary>
                    <pre>${safeSrc}</pre>
                </details>
            `;
        }

        pre.replaceWith(wrapper);
    }
}

function wireToolbar(wrapper: HTMLElement, source: string, svg: string) {
    const toolbar = wrapper.querySelector('.mermaid-diagram-toolbar');
    if (!toolbar) return;
    toolbar.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const btn = target.closest<HTMLButtonElement>('button[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'copy') {
            navigator.clipboard?.writeText(source).then(() => {
                const orig = btn.textContent;
                btn.textContent = 'Copied!';
                setTimeout(() => (btn.textContent = orig), 1500);
            });
        } else if (action === 'source') {
            const showing = wrapper.classList.toggle('mermaid-showing-source');
            let sourcePre = wrapper.querySelector<HTMLElement>('.mermaid-inline-source');
            if (showing) {
                if (!sourcePre) {
                    sourcePre = document.createElement('pre');
                    sourcePre.className = 'mermaid-inline-source';
                    sourcePre.textContent = source;
                    wrapper.appendChild(sourcePre);
                }
                btn.textContent = 'Diagram';
            } else {
                btn.textContent = 'Source';
            }
        } else if (action === 'expand') {
            openMermaidFullscreen(svg, source);
        }
    });
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
