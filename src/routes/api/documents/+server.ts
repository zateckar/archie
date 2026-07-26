import { json } from '@sveltejs/kit';
import { getDocuments } from '$lib/server/db';
import { addDocument } from '$lib/server/rag';

export async function GET() {
    return json(getDocuments());
}

export async function POST({ request }) {
    const { filename, content } = await request.json();
    if (!filename || !content) {
        return json({ error: 'Missing filename or content' }, { status: 400 });
    }
    // Ingestion can fail for reasons the operator needs to see and act on — most
    // usefully the embedding-dimension guard, which refuses to write a document
    // whose vectors came back from the fallback provider at a different dimension.
    // An unhandled throw here surfaced as an opaque 500, hiding the one message
    // that says what to do about it (retry, or `npm run reembed`).
    try {
        const { docId } = await addDocument(filename, content);
        return json({ id: docId });
    } catch (err) {
        const reason = (err as Error)?.message ?? String(err);
        console.error(`[Documents] Failed to ingest "${filename}":`, err);
        return json({ error: `Failed to ingest document: ${reason}` }, { status: 500 });
    }
}
