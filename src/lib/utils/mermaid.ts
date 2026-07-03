/**
 * Mermaid lazy-loader and render wrapper.
 *
 * Mermaid is a ~700KB gzipped dependency; we dynamically import it on first use
 * to keep the initial bundle small. All access goes through getMermaid().
 *
 * Browser-only — mermaid touches `window`/`document` during init, so all calls
 * must come from `$effect` / `onMount` / event handlers, never SSR.
 */

import { browser } from '$app/environment';

type MermaidModule = typeof import('mermaid').default;
type MermaidTheme = 'dark' | 'default' | 'neutral' | 'forest' | 'base';

let mermaidPromise: Promise<MermaidModule> | null = null;
let currentTheme: MermaidTheme = 'dark';

// Re-render callbacks registered by mounted MermaidDiagram components.
// Used when the app theme changes so we can re-init mermaid and refresh
// every visible diagram.
const reRenderCallbacks = new Set<() => void>();

function detectInitialTheme(): MermaidTheme {
    if (!browser) return 'dark';
    const appTheme = document.documentElement.getAttribute('data-theme');
    return appTheme === 'light' ? 'default' : 'dark';
}

/**
 * Lazy-load mermaid on first call. Cached as a singleton promise so
 * concurrent callers share the same import.
 */
export function getMermaid(): Promise<MermaidModule> {
    if (!browser) {
        return Promise.reject(new Error('Mermaid is browser-only'));
    }
    if (!mermaidPromise) {
        currentTheme = detectInitialTheme();
        mermaidPromise = import('mermaid').then((mod) => {
            const mermaid = mod.default;
            mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                theme: currentTheme,
                fontFamily: 'inherit',
                themeVariables: {
                    fontSize: '14px',
                },
            });
            return mermaid;
        });
    }
    return mermaidPromise;
}

export type MermaidRenderResult =
    | { ok: true; svg: string }
    | { ok: false; error: string };

/**
 * Render a single mermaid diagram. Returns SVG markup or a friendly error.
 * The `id` must be a unique, valid HTML id within the document.
 */
export async function renderMermaid(code: string, id: string): Promise<MermaidRenderResult> {
    try {
        const mermaid = await getMermaid();
        // mermaid leaves a temp <div id="d{id}"> in the DOM on error if not cleaned up;
        // we render into a detached container to avoid polluting the page.
        const { svg } = await mermaid.render(id, code);
        return { ok: true, svg };
    } catch (err: any) {
        // Mermaid leaves temp nodes on error; clean them up.
        if (browser) {
            const stray = document.getElementById(id);
            if (stray) stray.remove();
            const dStray = document.getElementById('d' + id);
            if (dStray) dStray.remove();
        }
        const msg = err?.message || err?.toString() || 'Unknown mermaid error';
        return { ok: false, error: msg };
    }
}

/**
 * Re-initialize mermaid with a new theme and trigger all mounted diagrams
 * to re-render. Call from theme store on theme change.
 */
export async function reinitializeMermaid(appTheme: 'dark' | 'light'): Promise<void> {
    if (!browser) return;
    const newTheme: MermaidTheme = appTheme === 'light' ? 'default' : 'dark';
    if (newTheme === currentTheme && mermaidPromise) return;
    currentTheme = newTheme;
    // If mermaid hasn't been loaded yet, nothing to re-init.
    if (!mermaidPromise) return;
    const mermaid = await mermaidPromise;
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: newTheme,
        fontFamily: 'inherit',
        themeVariables: {
            fontSize: '14px',
        },
    });
    // Trigger every mounted diagram to re-render.
    for (const cb of reRenderCallbacks) {
        try {
            cb();
        } catch (e) {
            console.error('[Mermaid] re-render callback failed', e);
        }
    }
}

export function registerReRenderCallback(cb: () => void): () => void {
    reRenderCallbacks.add(cb);
    return () => reRenderCallbacks.delete(cb);
}

/**
 * Stable, valid HTML id from arbitrary mermaid source code.
 * Mermaid requires the id to start with a letter.
 */
export function hashId(code: string): string {
    let h = 0;
    for (let i = 0; i < code.length; i++) {
        h = ((h << 5) - h + code.charCodeAt(i)) | 0;
    }
    return 'mmd-' + (h >>> 0).toString(36);
}
