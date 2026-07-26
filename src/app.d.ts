// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { SessionUser } from '$lib/server/auth';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			// Typed rather than `any`: `+layout.server.ts` returns `locals.user`
			// straight to the client, so this type is the contract for what a
			// browser is allowed to see. While it was `any`, nothing flagged that
			// the object being serialized carried `password_hash`.
			user: SessionUser | null;
			session: { id: string; user_id: number; expires_at: string } | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
