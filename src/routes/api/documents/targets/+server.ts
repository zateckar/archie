import { json } from '@sveltejs/kit';
import { listWikiRepos, listRepoFolders } from '$lib/server/wiki';
import { supportedExtensions, repoDisplayName } from '$lib/server/repo-upload';

/** Where a document can be uploaded: each repository with its folders, and the accepted file types. */
export async function GET() {
    const repos = listWikiRepos().map(r => ({
        id: r.id,
        name: repoDisplayName(r.url),
        folders: listRepoFolders(r.id)
    }));
    return json({ repos, extensions: supportedExtensions() });
}
