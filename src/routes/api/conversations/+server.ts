import { json } from '@sveltejs/kit';
import { createConversation, listConversations } from '$lib/server/conversations';

export async function GET({ url, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // `q` searches titles and message bodies alike — see listConversations.
        const conversations = listConversations(locals.user.id, { query: url.searchParams.get('q') ?? '' });
        return json(conversations);
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}

export async function POST({ request, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { title } = await request.json();
        return json(createConversation(locals.user.id, title || 'New Conversation'));
    } catch (err: any) {
        return json({ error: err.message }, { status: 500 });
    }
}
