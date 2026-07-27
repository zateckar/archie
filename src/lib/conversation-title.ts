/**
 * The sidebar title for a new conversation: the opening prompt, collapsed onto
 * one line and cut at a word boundary.
 *
 * The recents list wraps to two lines, so this is longer than the 50 characters
 * it used to store — at 50 nearly every title ended mid-word and the second line
 * had nothing to show.
 *
 * Shared: the chat endpoint writes the row, and the client mints the same title
 * optimistically when the stream hands back a new conversation id. They must
 * agree, or the entry visibly rewrites itself on the next page load.
 */
const TITLE_MAX = 120;

export function conversationTitle(prompt: string): string {
    const flat = prompt.replace(/\s+/g, ' ').trim();
    if (!flat) return 'New Conversation';
    if (flat.length <= TITLE_MAX) return flat;
    const cut = flat.slice(0, TITLE_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > TITLE_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}
