/**
 * Validation for uploading a document into a git repository.
 *
 * Uploads used to land only in SQLite: no history, no wiki page, and gone with
 * the database. They are now committed into a repository the uploader picks, at
 * a folder they pick or create, and from then on are ordinary git documents.
 * Everything a user types here becomes a path in someone's repository, so it is
 * checked before it reaches the filesystem — `resolveRepoPath` still confines
 * the result, this module makes sure it is a path worth writing.
 *
 * Dependency-free so it can be unit-tested without a database.
 */

import { IGNORE_PREFIX, LEGACY_CLEAN_FOLDER } from './wiki-ignore';

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Extensions the git sync ingests. An upload outside this list would be
 * committed, indexed once, and then deleted from the corpus by the next sync's
 * "no longer in the repo" sweep — so uploads accept exactly what sync accepts.
 */
export function supportedExtensions(raw: string | undefined = process.env.SUPPORTED_EXTENSIONS): string[] {
    const list = raw
        ? raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean).map(e => (e.startsWith('.') ? e : `.${e}`))
        : [];
    return list.length > 0 ? list : ['.md', '.mdx'];
}

// Characters Windows refuses in a file name, plus control characters. Repos are
// cloned on Windows machines too, and a name git accepts but Windows cannot
// check out breaks the clone for everyone on that platform.
const INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/;
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function checkSegment(segment: string, what: string): string | null {
    if (segment === '.' || segment === '..') return `${what} cannot be "." or ".."`;
    if (segment.startsWith('.')) return `${what} cannot start with "." ("${segment}")`;
    if (segment.startsWith(IGNORE_PREFIX)) {
        return `${what} cannot start with "${IGNORE_PREFIX}" — the app hides such paths ("${segment}")`;
    }
    if (INVALID_CHARS.test(segment)) return `${what} contains a character that is not allowed ("${segment}")`;
    if (RESERVED_WINDOWS.test(segment)) return `${what} is a reserved name on Windows ("${segment}")`;
    if (/[ .]$/.test(segment)) return `${what} cannot end with a space or a dot ("${segment}")`;
    if (segment.length > 255) return `${what} is too long`;
    return null;
}

/**
 * Normalises a repo-relative folder ("docs/guides", "\\docs\\", "") to
 * POSIX form without leading/trailing slashes. Empty string is the repo root.
 */
export function normalizeFolder(input: unknown): Checked<string> {
    if (input === undefined || input === null) return { ok: true, value: '' };
    if (typeof input !== 'string') return { ok: false, error: 'Folder must be a string' };

    const segments = input.split(/[\\/]/).map(s => s.trim()).filter(s => s !== '');
    for (const segment of segments) {
        const problem = checkSegment(segment, 'Folder name');
        if (problem) return { ok: false, error: problem };
    }
    const value = segments.join('/');
    if (isExcludedFromSync(value)) {
        return { ok: false, error: `"${LEGACY_CLEAN_FOLDER.slice(0, -1)}" holds generated copies and is not indexed — choose another folder` };
    }
    return { ok: true, value };
}

/**
 * True for a folder the git sync skips by name: the legacy cleaned-copies
 * folder. A document uploaded there would be indexed once by the upload and
 * then deleted from the corpus by the next sync.
 */
export function isExcludedFromSync(folder: string): boolean {
    return `${folder}/`.startsWith(LEGACY_CLEAN_FOLDER);
}

/** Checks an uploaded file's name: a plain name with a supported extension. */
export function checkUploadFilename(input: unknown, extensions: string[] = supportedExtensions()): Checked<string> {
    if (typeof input !== 'string' || input.trim() === '') return { ok: false, error: 'Missing filename' };
    const name = input.trim();
    if (/[\\/]/.test(name)) return { ok: false, error: 'Filename cannot contain a path' };

    const problem = checkSegment(name, 'Filename');
    if (problem) return { ok: false, error: problem };

    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
    if (!extensions.includes(ext)) {
        return { ok: false, error: `Only ${extensions.join(', ')} files can be uploaded — the git sync ignores other types` };
    }
    return { ok: true, value: name };
}

/** Joins a normalised folder and filename into a repo-relative path. */
export function uploadPath(folder: string, filename: string): string {
    return folder ? `${folder}/${filename}` : filename;
}

/**
 * The name an app-only upload gets when it is moved into a repository.
 *
 * Earlier uploads accepted `.txt`, which the git sync does not ingest — moved
 * as-is, the file would be deleted from the corpus by the next sync. Its text is
 * plain prose, which is valid markdown, so it is renamed to `.md`. Characters a
 * repository path cannot hold are replaced rather than refused: the upload is
 * already in the corpus, and refusing would strand it in the database.
 */
export function migrationFilename(
    filename: string,
    extensions: string[] = supportedExtensions()
): Checked<{ name: string; renamed: boolean }> {
    const original = (filename ?? '').split(/[\\/]/).pop()!.trim();
    const target = extensions.includes('.md') ? '.md' : extensions[0];

    const dot = original.lastIndexOf('.');
    const ext = dot > 0 ? original.slice(dot).toLowerCase() : '';
    let name = extensions.includes(ext) ? original : `${dot > 0 ? original.slice(0, dot) : original}${target}`;

    if (!checkUploadFilename(name, extensions).ok) {
        const stem = name.slice(0, name.lastIndexOf('.'));
        const safe = stem
            .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
            .replace(/^[.!\s]+/, '')
            .replace(/[ .]+$/, '')
            .slice(0, 200);
        name = `${safe || 'document'}${name.slice(name.lastIndexOf('.'))}`;
        if (RESERVED_WINDOWS.test(name)) name = `_${name}`;
    }

    const checked = checkUploadFilename(name, extensions);
    if (!checked.ok) return checked;
    return { ok: true, value: { name, renamed: name !== original } };
}

export type PlannedMove =
    | { id: number; filename: string; status: 'ready'; path: string; renamed: boolean }
    | { id: number; filename: string; status: 'conflict' | 'invalid'; path: string | null; renamed: boolean; reason: string };

/**
 * Assigns each upload a repository path under `folder`, and marks the ones that
 * cannot move there: an existing file (`taken` returns why), or two uploads in
 * this batch wanting the same path — uploads had no identity, so the same file
 * uploaded twice is common. The first (oldest) keeps the path; the rest are
 * reported, never silently renamed or overwritten.
 *
 * Paths are compared case-insensitively: two files differing only by case
 * collide when the repository is checked out on Windows.
 */
export function planMoves(
    uploads: { id: number; filename: string }[],
    folder: string,
    taken: (path: string) => string | null,
    extensions: string[] = supportedExtensions()
): PlannedMove[] {
    const claimed = new Map<string, string>();
    return uploads.map(u => {
        const named = migrationFilename(u.filename, extensions);
        if (!named.ok) return { id: u.id, filename: u.filename, status: 'invalid', path: null, renamed: false, reason: named.error };

        const path = uploadPath(folder, named.value.name);
        const renamed = named.value.renamed;
        const key = path.toLowerCase();
        const takenReason = taken(path);
        if (takenReason) return { id: u.id, filename: u.filename, status: 'conflict', path, renamed, reason: takenReason };
        const claimedBy = claimed.get(key);
        if (claimedBy !== undefined) {
            return { id: u.id, filename: u.filename, status: 'conflict', path, renamed, reason: `Another upload in this list ("${claimedBy}") is moving to the same path` };
        }
        claimed.set(key, u.filename);
        return { id: u.id, filename: u.filename, status: 'ready', path, renamed };
    });
}

/** Short display name for a repository URL: its last path segment, minus `.git`. */
export function repoDisplayName(url: string): string {
    const last = url.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || url;
    return last.replace(/\.git$/i, '');
}
