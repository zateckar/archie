/**
 * The "!" prefix convention: any file or folder whose name starts with `!` is
 * invisible to this app.
 *
 * It exists so a repository can hold material the wiki should not show and the
 * RAG pipeline should not ingest — generated copies, scratch drafts, archived
 * versions — without moving it out of the repo or maintaining an exclusion list
 * in the app. Renaming `Clean` to `!Clean` is all it takes.
 *
 * The rule is deliberately dumb: a leading `!` on ANY path segment hides that
 * entry and everything under it. `!Clean`, `!-Clean`, `!README.md` and
 * `!_README.md` are all ignored, and so is `docs/!drafts/notes.md`, because its
 * `!drafts` parent is. There is no escaping mechanism and no per-repo
 * configuration; a one-character rename is the whole interface.
 *
 * `!` was chosen because git treats it as an ordinary filename character (unlike
 * `.`, which many tools hide for their own reasons, and unlike a `!` at the start
 * of a *.gitignore line*, where it means negation — that has no bearing on
 * filenames). It sorts first in most listings, which keeps ignored folders
 * grouped at the top of a plain directory view.
 *
 * Dependency-free on purpose: the ingestion path (git.ts), the wiki file/tree
 * layer (wiki.ts) and the document store (rag.ts) all consult the same predicate,
 * so "ignored" cannot mean different things in different places.
 */

/** Marks a path segment as ignored when it appears at the start of the name. */
export const IGNORE_PREFIX = '!';

/**
 * Folder the ingestion pipeline stages its cleaned copy of each document into.
 *
 * Prefixed, so it is hidden from the wiki and skipped by ingestion through the
 * general rule above rather than by a name-specific exception — the cleaned copies
 * are a derived artifact of the corpus and must never be ingested as sources in
 * their own right.
 *
 * `LEGACY_CLEAN_FOLDER` is the unprefixed name this app wrote to before the
 * convention existed. Nothing writes there any more, but existing repositories
 * still hold one, so both names stay excluded from ingestion and both are watched
 * when deciding whether staged cleaned files need committing. The old folder is
 * deliberately left in place and still visible in the wiki: it is committed
 * history, and moving or deleting a user's files is not this change's business.
 */
export const CLEAN_FOLDER = '!Clean/';
export const LEGACY_CLEAN_FOLDER = 'Clean/';

/**
 * True when any segment of `filePath` starts with `!`.
 *
 * Accepts both separators — callers hand over a mix of repo-relative POSIX paths
 * (git.listFiles) and OS paths (fs walks) — and tolerates `./`, empty segments
 * and a trailing slash, so `!Clean`, `!Clean/`, `./!Clean/a.md` and
 * `docs\\!drafts\\a.md` all answer the same.
 */
export function isIgnoredPath(filePath: string): boolean {
    if (typeof filePath !== 'string' || filePath.length === 0) return false;

    return filePath
        .split(/[\\/]/)
        .some(segment => segment !== '' && segment !== '.' && segment.startsWith(IGNORE_PREFIX));
}

/** True when a single directory entry name is ignored. Not path-aware. */
export function isIgnoredName(name: string): boolean {
    return typeof name === 'string' && name.startsWith(IGNORE_PREFIX);
}
