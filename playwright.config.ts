import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './e2e',
	/* Run tests sequentially — some tests depend on shared state (DB) */
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: [['html', { open: 'never' }], ['list']],

	/* Global timeouts — AI streaming + git clone can be slow */
	timeout: 90_000,
	expect: { timeout: 15_000 },

	use: {
		baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
	},

	projects: [
		/* 1. Auth setup — runs once, saves cookie state */
		{
			name: 'setup',
			testMatch: /auth\.setup\.ts/,
			use: { ...devices['Desktop Chrome'] },
		},

		/* 2. All feature tests — reuse saved auth cookies */
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				storageState: 'e2e/.auth/admin.json',
			},
			dependencies: ['setup'],
			testIgnore: /auth\.setup\.ts/,
		},
	],

	webServer: {
		command: 'npm run dev',
		url: 'http://localhost:5173',
		reuseExistingServer: true,
		timeout: 30_000,
	},
});
