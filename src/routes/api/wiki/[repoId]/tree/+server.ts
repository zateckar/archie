import { json } from '@sveltejs/kit';
import { getFileTree } from '$lib/server/wiki';

export async function GET({ params }) {
    const repoId = parseInt(params.repoId);
    const tree = getFileTree(repoId);
    return json(tree);
}