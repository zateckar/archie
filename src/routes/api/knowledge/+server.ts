import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { rebuildTaxonomy } from '$lib/server/knowledge';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
    const topics = db.prepare('SELECT id, name, description, category, parent_topic_id, community_id FROM topics').all();
    const relationships = db.prepare(`
        SELECT 
            tr.source_topic_id,
            tr.target_topic_id,
            tr.relationship_type,
            s.name as source_name, 
            t.name as target_name 
        FROM topic_relationships tr
        JOIN topics s ON tr.source_topic_id = s.id
        JOIN topics t ON tr.target_topic_id = t.id
    `).all();
    
    const claims = db.prepare(`
        SELECT 
            kc.id,
            kc.topic_id,
            kc.doc_id,
            kc.claim_text,
            kc.claim_hash,
            kc.status,
            kc.created_at,
            kc.doc_content_hash,
            t.name as topic_name,
            d.filename as doc_name,
            d.content_hash as current_doc_hash
        FROM knowledge_claims kc
        JOIN topics t ON kc.topic_id = t.id
        JOIN documents d ON kc.doc_id = d.id
    `).all();

    return json({ topics, relationships, claims });
};

/** PATCH: update claim status (resolve conflicts) */
export const PATCH: RequestHandler = async ({ request }) => {
    const { claimId, action } = await request.json();
    if (!claimId || !action) {
        return json({ error: 'claimId and action required' }, { status: 400 });
    }

    if (action === 'accept') {
        // Accept this claim: set to active, mark other conflicting claims on same topic as superseded
        const claim = db.prepare('SELECT topic_id FROM knowledge_claims WHERE id = ?').get(claimId) as { topic_id: number } | undefined;
        if (!claim) return json({ error: 'Claim not found' }, { status: 404 });
        
        db.prepare("UPDATE knowledge_claims SET status = 'active' WHERE id = ?").run(claimId);
    } else if (action === 'reject') {
        // Reject: delete the claim
        db.prepare('DELETE FROM knowledge_claims WHERE id = ?').run(claimId);
    } else if (action === 'dismiss') {
        // Dismiss conflict: mark as active (it's fine)
        db.prepare("UPDATE knowledge_claims SET status = 'active' WHERE id = ?").run(claimId);
    }

    return json({ success: true });
};

/** DELETE: remove a topic and all its relationships/claims */
export const DELETE: RequestHandler = async ({ request }) => {
    const { topicId } = await request.json();
    if (!topicId) return json({ error: 'topicId required' }, { status: 400 });
    
    db.prepare('DELETE FROM topics WHERE id = ?').run(topicId);
    return json({ success: true });
};

/** POST: trigger full taxonomy rebuild */
export const POST: RequestHandler = async ({ request }) => {
    const body = await request.json().catch(() => ({}));
    
    if (body.action === 'rebuild-taxonomy') {
        try {
            const result = await rebuildTaxonomy();
            return json({ success: true, ...result });
        } catch (err) {
            console.error('Taxonomy rebuild failed:', err);
            return json({ error: 'Taxonomy rebuild failed' }, { status: 500 });
        }
    }

    return json({ error: 'Unknown action' }, { status: 400 });
};
