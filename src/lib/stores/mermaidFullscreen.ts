/**
 * Singleton store powering the fullscreen Mermaid diagram viewer.
 *
 * Two independent diagram rendering paths need to trigger the same modal:
 *  - `mermaidRender.ts` (raw-DOM post-processing used for chat messages / wiki view)
 *  - `MermaidDiagram.svelte` (live Svelte component used in the editor's live preview)
 *
 * A plain Svelte store keeps both paths decoupled from the modal component itself —
 * neither call site needs to know the modal exists, they just call `openMermaidFullscreen`.
 */

import { writable } from 'svelte/store';

export interface MermaidFullscreenState {
    open: boolean;
    svg: string;
    source: string;
}

const initialState: MermaidFullscreenState = { open: false, svg: '', source: '' };

export const mermaidFullscreenState = writable<MermaidFullscreenState>(initialState);

/** Open the fullscreen viewer with already-rendered SVG markup (and optional source for copy). */
export function openMermaidFullscreen(svg: string, source = ''): void {
    mermaidFullscreenState.set({ open: true, svg, source });
}

/** Close the fullscreen viewer. */
export function closeMermaidFullscreen(): void {
    mermaidFullscreenState.update((s) => ({ ...s, open: false }));
}
