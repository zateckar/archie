import { json } from '@sveltejs/kit';
import { deleteDocument } from '$lib/server/db';

export async function DELETE({ params }) {
    const id = parseInt(params.id);
    deleteDocument(id);
    return json({ success: true });
}
