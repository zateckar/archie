import { describe, it, expect } from 'vitest';
import { conversationTitle } from './conversation-title';

describe('conversationTitle', () => {
    it('keeps a short prompt verbatim', () => {
        expect(conversationTitle('What is TS-FIV?')).toBe('What is TS-FIV?');
    });

    it('collapses newlines and runs of whitespace onto one line', () => {
        // The recents row is a two-line clamp, not a <pre> — a stored newline
        // would eat one of the two lines it has.
        expect(conversationTitle('Summarise\n\n  the   spec')).toBe('Summarise the spec');
    });

    it('falls back to a placeholder for an empty or blank prompt', () => {
        expect(conversationTitle('')).toBe('New Conversation');
        expect(conversationTitle('   \n\t ')).toBe('New Conversation');
    });

    it('cuts a long prompt at a word boundary and marks the cut', () => {
        const prompt = 'word '.repeat(60).trim();
        const title = conversationTitle(prompt);
        expect(title.length).toBeLessThanOrEqual(121); // 120 + the ellipsis
        expect(title.endsWith('…')).toBe(true);
        expect(title.slice(0, -1).endsWith('word')).toBe(true);
    });

    it('hard-cuts a long unbroken run rather than losing most of it', () => {
        // No space to fall back to; trimming to the last space would return a
        // near-empty title.
        const title = conversationTitle('x'.repeat(300));
        expect(title).toBe('x'.repeat(120) + '…');
    });

    it('does not add an ellipsis at exactly the limit', () => {
        const exact = 'y'.repeat(120);
        expect(conversationTitle(exact)).toBe(exact);
    });
});
