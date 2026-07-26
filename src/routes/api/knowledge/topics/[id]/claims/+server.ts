import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';

export async function GET({ params, url, locals }) {
    const user = locals.user;
    if (!user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const topicId = parseInt(params.id, 10);
    if (isNaN(topicId)) {
        return json({ error: 'Invalid topic ID' }, { status: 400 });
    }

    const status = url.searchParams.get('status') || 'active';
    const offsetParam = url.searchParams.get('offset');
    const limitParam = url.searchParams.get('limit');
    const offset = offsetParam ? parseInt(offsetParam, 10) : 0;
    const limit = limitParam ? parseInt(limitParam, 10) : 50;

    if (!['active', 'conflicting', 'flagged', 'superseded', 'all'].includes(status)) {
        return json({ error: 'Invalid status. Must be "active", "conflicting", "flagged", "superseded", or "all"' }, { status: 400 });
    }

    try {
        // Build query based on status filter.
        // A superseded claim joins to its replacement so the history view can
        // show what took its place, not just that something did.
        let sql = `
            SELECT kc.id, kc.claim_text, kc.status, kc.created_at, kc.doc_content_hash,
                   kc.superseded_by, kc.superseded_at, succ.claim_text AS superseded_by_text,
                   d.filename, d.path
            FROM knowledge_claims kc
            LEFT JOIN documents d ON kc.doc_id = d.id
            LEFT JOIN knowledge_claims succ ON kc.superseded_by = succ.id
            WHERE kc.topic_id = ?
        `;

        const params: any[] = [topicId];

        if (status !== 'all') {
            sql += ' AND kc.status = ?';
            params.push(status);
        }

        sql += ' ORDER BY kc.created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const claims = db.prepare(sql).all(...params);

        // Get total count for pagination
        let countSql = 'SELECT COUNT(*) as total FROM knowledge_claims WHERE topic_id = ?';
        const countParams: any[] = [topicId];

        if (status !== 'all') {
            countSql += ' AND status = ?';
            countParams.push(status);
        }

        const { total } = db.prepare(countSql).get(...countParams) as { total: number };

        return json({
            claims,
            pagination: {
                total,
                offset,
                limit,
                hasMore: offset + limit < total
            }
        });
    } catch (error) {
        console.error('Claims fetch error:', error);
        return json({ error: 'Failed to fetch claims' }, { status: 500 });
    }
}
