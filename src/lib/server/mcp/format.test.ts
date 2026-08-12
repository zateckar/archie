import { describe, it, expect } from 'vitest';
import {
    dedupeSources,
    formatClarificationRequest,
    formatConversationList,
    formatKnowledgeHits,
    formatSourceList,
    formatTranscript,
    sourceLabel,
    wikiUrl,
    withSourceFooter
} from './format';

/**
 * What an MCP client's model actually reads. The failure modes worth pinning are
 * the ones that mislead rather than crash: a citation that links to a page which
 * does not exist, an answer that arrives with its sources silently dropped, or a
 * transcript whose turn numbers don't line up with the index `rate_answer` takes.
 */

describe('sourceLabel', () => {
    it('prefers the repo-relative path, since two repos can share a filename', () => {
        expect(sourceLabel({ filename: 'readme.md', path: 'docs/readme.md' })).toBe('docs/readme.md');
    });

    it('falls back to the filename for an uploaded document', () => {
        expect(sourceLabel({ filename: 'handbook.pdf', path: null })).toBe('handbook.pdf');
        expect(sourceLabel({ filename: 'handbook.pdf' })).toBe('handbook.pdf');
    });
});

describe('wikiUrl', () => {
    it('links to the wiki page when both halves are known', () => {
        expect(wikiUrl({ filename: 'a.md', path: 'docs/a.md', repo_id: 3 })).toBe('/wiki/3/docs/a.md');
    });

    it('returns null when there is no page, rather than a URL that 404s', () => {
        expect(wikiUrl({ filename: 'a.md', path: 'docs/a.md', repo_id: null })).toBeNull();
        expect(wikiUrl({ filename: 'a.md', path: null, repo_id: 3 })).toBeNull();
        expect(wikiUrl({ filename: 'a.md' })).toBeNull();
    });

    it('encodes each segment but keeps the separators', () => {
        expect(wikiUrl({ filename: 'b.md', path: 'my docs/a#b.md', repo_id: 1 })).toBe('/wiki/1/my%20docs/a%23b.md');
    });
});

describe('dedupeSources', () => {
    it('keeps the first mention of each document, in citation order', () => {
        const sources = [
            { filename: 'a.md', path: 'docs/a.md' },
            { filename: 'b.md', path: 'docs/b.md' },
            { filename: 'a.md', path: 'docs/a.md' }
        ];
        expect(dedupeSources(sources).map(sourceLabel)).toEqual(['docs/a.md', 'docs/b.md']);
    });
});

describe('formatSourceList', () => {
    it('is empty when there are no sources', () => {
        expect(formatSourceList([])).toBe('');
    });

    it('lists the wiki link only where there is one', () => {
        const text = formatSourceList([
            { filename: 'a.md', path: 'docs/a.md', repo_id: 2 },
            { filename: 'upload.pdf', path: null, repo_id: null }
        ]);
        expect(text).toBe('- docs/a.md (/wiki/2/docs/a.md)\n- upload.pdf');
    });
});

describe('withSourceFooter', () => {
    it('leaves an answer alone when nothing was cited', () => {
        expect(withSourceFooter('The answer.', [])).toBe('The answer.');
    });

    it('keeps the answer first and appends the citations', () => {
        const text = withSourceFooter('The answer.', [{ filename: 'a.md', path: 'docs/a.md', repo_id: 1 }]);
        expect(text.startsWith('The answer.')).toBe(true);
        expect(text).toContain('**Sources**');
        expect(text).toContain('docs/a.md');
    });

    it('does not repeat a document cited by several chunks', () => {
        const source = { filename: 'a.md', path: 'docs/a.md', repo_id: 1 };
        const text = withSourceFooter('The answer.', [source, source, source]);
        expect(text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1);
    });
});

describe('formatClarificationRequest', () => {
    it('numbers the questions and says how to come back', () => {
        const text = formatClarificationRequest(['Which release?', 'Which market?']);
        expect(text).toContain('1. Which release?');
        expect(text).toContain('2. Which market?');
        // Without this the client re-asks and gets clarified at all over again.
        expect(text).toContain('answering_clarification: true');
    });
});

describe('formatConversationList', () => {
    it('says so when there is nothing to list', () => {
        expect(formatConversationList([])).toBe('No conversations found.');
    });

    it('marks pinned threads and always shows the id to continue with', () => {
        const text = formatConversationList([
            { id: 'abc', title: 'Pinned thread', pinned: 1, updated_at: '2026-08-01 10:00:00' },
            { id: 'def', title: 'Other thread', pinned: 0, updated_at: '2026-07-31 09:00:00' }
        ]);
        expect(text).toContain('📌 Pinned thread');
        expect(text).toContain('id: abc');
        expect(text).toContain('id: def');
        expect(text).not.toContain('📌 Other thread');
    });
});

describe('formatTranscript', () => {
    it('says so when the conversation is empty', () => {
        expect(formatTranscript([])).toBe('This conversation has no messages.');
    });

    it('numbers turns from zero, matching the index rate_answer takes', () => {
        const text = formatTranscript([
            { role: 'user', content: 'Question?' },
            { role: 'assistant', content: 'Answer.', sources: [{ filename: 'a.md', path: 'docs/a.md' }] }
        ]);
        expect(text).toContain('### [0] User');
        expect(text).toContain('### [1] Assistant');
        expect(text).toContain('Sources: docs/a.md');
    });

    it('omits the sources line for a turn that cited nothing', () => {
        expect(formatTranscript([{ role: 'user', content: 'Question?' }])).not.toContain('Sources:');
    });
});

describe('formatKnowledgeHits', () => {
    it('is explicit about finding nothing', () => {
        expect(formatKnowledgeHits([], [])).toBe('Nothing in the knowledge base matched that query.');
    });

    it('shows scores so a weak match is not read as a strong one', () => {
        const text = formatKnowledgeHits(
            [{ name: 'Braking', description: 'Systems', category: 'technical', score: 0.9123 }],
            [
                {
                    claim_text: 'Pads are replaced every 30k km.',
                    topic_name: 'Braking',
                    claim_type: 'assertion',
                    filename: 'a.md',
                    path: 'docs/a.md',
                    score: 0.3141
                }
            ]
        );
        expect(text).toContain('**Topics**');
        expect(text).toContain('- Braking [technical] — Systems (0.91)');
        expect(text).toContain('**Facts**');
        expect(text).toContain('Pads are replaced every 30k km.');
        expect(text).toContain('docs/a.md (0.31)');
    });

    it('omits a section that has no hits', () => {
        const text = formatKnowledgeHits([{ name: 'Braking', description: null, category: null, score: 0.5 }], []);
        expect(text).toContain('**Topics**');
        expect(text).not.toContain('**Facts**');
    });
});
