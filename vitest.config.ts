import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Unit tests run in a plain Node environment, deliberately *without* the
 * sveltekit() plugin. These cover pure server-side logic (normalisation, graph
 * math, JSON salvage) that has no need of the SvelteKit module graph, and
 * loading the plugin here would drag in `$app/*` virtual modules and require
 * `svelte-kit sync` to have run first.
 *
 * Browser/end-to-end coverage stays in Playwright (`e2e/`, `npm test`).
 */
export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        globals: false
    },
    resolve: {
        alias: {
            $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
        }
    }
});
