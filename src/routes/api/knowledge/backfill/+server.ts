import { json } from '@sveltejs/kit';
import { backfillAllEmbeddings } from '$lib/server/rag';

/**
 * POST /api/knowledge/backfill
 * Generates embeddings for any topics or claims that are missing them.
 * Safe to call multiple times — only processes rows where embedding IS NULL.
 */
export async function POST({ locals }) {
    if (!locals.user || locals.user.role !== 'admin') {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const result = await backfillAllEmbeddings();
        return json({ ok: true, ...result });
    } catch (err: any) {
        console.error('backfillAllEmbeddings failed:', err);
        return json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
    }
}
