import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';

export async function GET({ params, locals }) {
    const user = locals.user;
    if (!user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const topicId = parseInt(params.id, 10);
    if (isNaN(topicId)) {
        return json({ error: 'Invalid topic ID' }, { status: 400 });
    }

    try {
        // Get topic details
        const topic = db.prepare(`
            SELECT id, name, description, category, parent_topic_id, created_at
            FROM topics
            WHERE id = ?
        `).get(topicId) as { id: number; name: string; description: string | null; category: string | null; parent_topic_id: number | null; created_at: string } | undefined;

        if (!topic) {
            return json({ error: 'Topic not found' }, { status: 404 });
        }

        // Count claims for this topic
        const claimCount = (db.prepare('SELECT COUNT(*) as count FROM knowledge_claims WHERE topic_id = ?').get(topicId) as { count: number }).count;

        // Count relationships
        const relationshipCount = (db.prepare('SELECT COUNT(*) as count FROM topic_relationships WHERE source_topic_id = ? OR target_topic_id = ?').all(topicId, topicId) as { count: number }[]).reduce((sum, row) => sum + row.count, 0);

        return json({
            ...topic,
            claim_count: claimCount,
            relationship_count: relationshipCount
        });
    } catch (error) {
        console.error('Topic fetch error:', error);
        return json({ error: 'Failed to fetch topic' }, { status: 500 });
    }
}
