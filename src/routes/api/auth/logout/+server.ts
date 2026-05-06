import { redirect } from '@sveltejs/kit';
import { invalidateSession } from '$lib/server/auth';

export async function POST({ cookies, locals }) {
    if (locals.session) {
        invalidateSession(locals.session.id);
    }
    cookies.delete('session', { path: '/' });
    throw redirect(302, '/login');
}
