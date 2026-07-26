import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		adapter: adapter(),
		csp: {
			mode: 'nonce',
			directives: {
				'default-src': ['self'],
				'script-src': ['self', 'sha256-jX1giMleF9KSRMJQyM1jb3B4tNFjYgeD7u7GfWEdTkY='],
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:', 'blob:'],
				'font-src': ['self'],
				'connect-src': ['self', 'ws:', 'wss:', 'https://generativelanguage.googleapis.com'],
				'frame-ancestors': ['none'],
				'base-uri': ['self'],
				// `form-action` does NOT fall back to `default-src` — with it absent,
				// form submission to any origin was permitted. That was the one gap
				// this policy left open against HTML injected into rendered markdown:
				// script execution is already blocked by `script-src` having no
				// 'unsafe-inline', and exfiltration by `img-src 'self'`, but an
				// injected <form> posting a fake "session expired, re-enter your
				// password" prompt to an attacker origin would have submitted fine.
				'form-action': ['self'],
				// Belt-and-braces against plugin/embed content; `object-src` does
				// inherit from `default-src`, but stating 'none' is unambiguous.
				'object-src': ['none']
			}
		}
	}
};

export default config;
