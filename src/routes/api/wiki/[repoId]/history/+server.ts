import { json } from '@sveltejs/kit';
import { getFileHistory } from '$lib/server/wiki';

export async function GET({ params, url }) {
    const repoId = parseInt(params.repoId);
    const filePath = url.searchParams.get('path');

    if (!filePath) {
        return json({ error: 'Missing path parameter' }, { status: 400 });
    }

    const history = await getFileHistory(repoId, filePath);
    return json(history);
}