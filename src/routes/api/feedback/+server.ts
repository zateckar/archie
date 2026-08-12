import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { recordFeedback } from '$lib/server/conversations';

export async function POST({ request, locals }: RequestEvent) {
    const user = locals.user;
    if (!user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { conversationId, messageIndex, rating } = await request.json();

    if (!conversationId || typeof conversationId !== 'string' || !Number.isInteger(messageIndex) || ![-1, 1].includes(rating)) {
        return json({ error: 'Invalid feedback data' }, { status: 400 });
    }

    try {
        // Ownership is enforced in recordFeedback: a rating is stored with a
        // snapshot of the exchange it judged, so rating someone else's
        // conversation would copy their text into this user's feedback row.
        const result = recordFeedback(user.id, conversationId, messageIndex, rating);
        if (!result.ok) {
            return json({ error: result.error }, { status: result.status });
        }
        return json({ success: true });
    } catch (e) {
        console.error('[Feedback] Failed to store:', e);
        return json({ error: 'Failed to store feedback' }, { status: 500 });
    }
}
