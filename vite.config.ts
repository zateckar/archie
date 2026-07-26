import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// Vite ignores PORT on its own; honouring it lets a second dev server run
	// alongside one that already holds 5173 (defaults to Vite's own behaviour
	// when PORT is unset).
	server: process.env.PORT ? { port: Number(process.env.PORT) } : undefined,
	ssr: {
		external: ['better-sqlite3']
	}
});
