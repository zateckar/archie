import { describe, it, expect } from 'vitest';
import {
    checkDimension,
    checkUniformDimensions,
    EmbeddingDimensionError
} from './embedding-dimension';

/**
 * These cover the pure comparison functions rather than the db-backed wrappers,
 * which is why the logic was split that way — same reason fts-query.ts and
 * retrieval-probe.ts are testable without importing rag.ts.
 *
 * The behaviour under test is what stops a provider fallback (LiteLLM → Gemini,
 * different vector lengths) from writing rows that sqlite-vector accepts without
 * complaint and then silently omits from every search result.
 */

const vec = (n: number) => Array.from({ length: n }, (_, i) => i / n);

describe('checkDimension', () => {
    it('accepts any dimension into an empty table and reports it', () => {
        expect(checkDimension(null, vec(4096), 'chunks', 'first write')).toBe(4096);
        expect(checkDimension(null, vec(3072), 'topics', 'first write')).toBe(3072);
    });

    it('accepts a vector matching what the table already holds', () => {
        expect(checkDimension(4096, vec(4096), 'chunks', 'doc.md')).toBe(4096);
    });

    it('rejects the provider-fallback case: 3072-dim into a 4096-dim table', () => {
        expect(() => checkDimension(4096, vec(3072), 'chunks', 'doc.md')).toThrow(EmbeddingDimensionError);
    });

    it('rejects a mismatch in the other direction too', () => {
        expect(() => checkDimension(3072, vec(4096), 'topics', 'topic "X"')).toThrow(EmbeddingDimensionError);
    });

    it('names the table, the label, and both dimensions so the log is actionable', () => {
        expect(() => checkDimension(4096, vec(3072), 'knowledge_claims', 'claim 7 on "Řízení"')).toThrow(
            /knowledge_claims.*claim 7 on "Řízení".*3072-dim.*4096-dim/s
        );
    });

    it('rejects an empty or non-array vector rather than storing a null embedding', () => {
        expect(() => checkDimension(null, [], 'chunks', 'empty')).toThrow(EmbeddingDimensionError);
        expect(() => checkDimension(4096, undefined as unknown as number[], 'chunks', 'undefined')).toThrow(
            EmbeddingDimensionError
        );
    });
});

describe('checkUniformDimensions', () => {
    it('treats an empty batch as nothing to check', () => {
        expect(checkUniformDimensions(null, [], 'chunks', 'no chunks')).toBeNull();
    });

    it('accepts a uniform batch into an empty table', () => {
        expect(checkUniformDimensions(null, [vec(4096), vec(4096), vec(4096)], 'chunks', 'doc.md')).toBe(4096);
    });

    it('rejects a batch that changed dimension partway through', () => {
        // The real shape of a fallback during ingestion: the first chunks embed
        // against LiteLLM, the gateway fails, the rest come back from Gemini.
        const batch = [vec(4096), vec(4096), vec(3072), vec(3072)];
        expect(() => checkUniformDimensions(null, batch, 'chunks', 'doc.md')).toThrow(EmbeddingDimensionError);
    });

    it('reports which item in the batch diverged', () => {
        expect(() => checkUniformDimensions(null, [vec(4096), vec(4096), vec(3072)], 'chunks', 'doc.md')).toThrow(
            /item 0 is 4096-dim but item 2 is 3072-dim/
        );
    });

    it('rejects a uniform batch that disagrees with the existing table', () => {
        expect(() => checkUniformDimensions(4096, [vec(3072), vec(3072)], 'chunks', 'doc.md')).toThrow(
            EmbeddingDimensionError
        );
    });
});
