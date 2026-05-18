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
    const { docId } = await addDocument(filename, content);
    return json({ id: docId });
}
