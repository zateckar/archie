import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { rebuildTaxonomy } from '$lib/server/knowledge';
import type { RequestHandler } from './$types';

/**
 * Claim/topic mutations. There is deliberately NO `GET` here.
 *
 * This route used to answer GET with the entire knowledge graph — every topic
 * with its description, every relationship, every claim — which both the explorer
 * and this page's admin twin then filtered, counted and grouped in the browser.
 * On a corpus of 1585 topics / 4170 relationships / 2178 claims that is the
 * single largest response the app produced, it grew with every ingested document,
 * and it made per-card counts quadratic on the client.
 *
 * It has been replaced by four bounded endpoints, and is not kept as a
 * convenience: an unbounded "give me everything" route is exactly the shape that
 * gets reached for again.
 *
 *   GET /api/knowledge/topics  — paged topics with SQL-computed counts
 *   GET /api/knowledge/claims  — paged claims, filterable by topic and status
 *   GET /api/knowledge/stats   — headline counts
 *   GET /api/knowledge/graph   — a bounded, connected subgraph for the canvas
 */

/** PATCH: update claim status (resolve conflicts) */
export const PATCH: RequestHandler = async ({ request, locals }) => {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

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
    } else if (action === 'restore') {
        // Undo a supersession the consistency checker got wrong. Retirement is
        // driven by an LLM verdict, so it needs a human-reversible path — the
        // claim was never deleted, just retired, and this puts it back in
        // retrieval and clears the pointer to its supposed replacement.
        const claim = db
            .prepare('SELECT status FROM knowledge_claims WHERE id = ?')
            .get(claimId) as { status: string } | undefined;
        if (!claim) return json({ error: 'Claim not found' }, { status: 404 });
        if (claim.status !== 'superseded') {
            return json({ error: `Claim is '${claim.status}', not 'superseded'` }, { status: 409 });
        }
        db.prepare(
            "UPDATE knowledge_claims SET status = 'active', superseded_by = NULL, superseded_at = NULL WHERE id = ?"
        ).run(claimId);
    } else {
        return json({ error: `Unknown action '${action}'` }, { status: 400 });
    }

    return json({ success: true });
};

/** DELETE: remove a topic and all its relationships/claims */
export const DELETE: RequestHandler = async ({ request, locals }) => {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { topicId } = await request.json();
    if (!topicId) return json({ error: 'topicId required' }, { status: 400 });
    
    db.prepare('DELETE FROM topics WHERE id = ?').run(topicId);
    return json({ success: true });
};

/** POST: trigger full taxonomy rebuild */
export const POST: RequestHandler = async ({ request, locals }) => {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

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
