import { json } from '@sveltejs/kit';
import { deleteDocument } from '$lib/server/db';
import { sweepOrphanTopics } from '$lib/server/knowledge';

export async function DELETE({ params }) {
    const id = parseInt(params.id);
    deleteDocument(id);
    // The document's chunks, claims and topic links go with it (FK cascade), but
    // topics and graph edges have no document FK — without this sweep, a deleted
    // document's topics stay in the graph and keep being retrieved.
    sweepOrphanTopics();
    return json({ success: true });
}
