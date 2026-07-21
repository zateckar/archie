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
import { sanitizeMermaid } from './mermaidSanitize';

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
 *
 * Robustness: LLM-generated source frequently contains small syntax mistakes.
 * We first attempt to render the source as-is; on failure we run a conservative
 * repair pass (see `sanitizeMermaid`) and retry once. Valid diagrams are never
 * altered — only broken ones trigger the repair path.
 */
export async function renderMermaid(code: string, id: string): Promise<MermaidRenderResult> {
    const mermaid = await getMermaid().catch(() => null);
    if (!mermaid) return { ok: false, error: 'Mermaid failed to load' };

    // Attempt 1: render the source verbatim.
    const first = await tryRender(mermaid, code, id);
    if (first.ok) return first;

    // Attempt 2: repair common mistakes and retry (only if repair changed anything).
    let repaired: string;
    try {
        repaired = sanitizeMermaid(code);
    } catch {
        repaired = code;
    }
    if (repaired && repaired.trim() !== code.trim()) {
        const second = await tryRender(mermaid, repaired, id + '-fixed');
        if (second.ok) return second;
    }

    // Both attempts failed — surface the original error, which is most relevant
    // to the source the user/LLM actually produced.
    return first;
}

/**
 * Single render attempt with DOM cleanup of the temp nodes mermaid leaves behind
 * on parse errors.
 */
async function tryRender(
    mermaid: MermaidModule,
    code: string,
    id: string
): Promise<MermaidRenderResult> {
    try {
        const { svg } = await mermaid.render(id, code);
        return { ok: true, svg };
    } catch (err: any) {
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
