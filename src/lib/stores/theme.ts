import { writable } from 'svelte/store';
import { browser } from '$app/environment';

type Theme = 'dark' | 'light';

function createThemeStore() {
	const initial: Theme = browser
		? (localStorage.getItem('archie-theme') as Theme) || 'dark'
		: 'dark';

	const { subscribe, set } = writable<Theme>(initial);

	if (browser) {
		document.documentElement.setAttribute('data-theme', initial);
	}

	return {
		subscribe,
		toggle() {
			const next: Theme = document.documentElement.getAttribute('data-theme') === 'dark'
				? 'light'
				: 'dark';
			document.documentElement.setAttribute('data-theme', next);
			localStorage.setItem('archie-theme', next);
			set(next);
		},
		set(theme: Theme) {
			document.documentElement.setAttribute('data-theme', theme);
			localStorage.setItem('archie-theme', theme);
			set(theme);
		}
	};
}

export const theme = createThemeStore();
