import { describe, it, expect } from 'vitest';
import { cosineSimilarity, pickComparableClaims, nearest, blobToVector } from './claim-similarity';

describe('cosineSimilarity', () => {
    it('is 1 for parallel, 0 for orthogonal and for a zero vector', () => {
        expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
        expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
        expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    });
});

describe('pickComparableClaims', () => {
    const existing = [
        { id: 1, embedding: [1, 0] },
        { id: 2, embedding: [0, 1] },
        { id: 3, embedding: [0.9, 0.1] },
        { id: 4, embedding: null }
    ];

    it('returns everything when under the limit', () => {
        expect(pickComparableClaims(existing, [[1, 0]], 10)).toBe(existing);
    });

    it('keeps the nearest claims (and unembedded ones) in original order', () => {
        const picked = pickComparableClaims(existing, [[1, 0]], 3);
        expect(picked.map(c => c.id)).toEqual([1, 3, 4]);
    });

    it('scores against the closest of several new claims', () => {
        const picked = pickComparableClaims(existing.slice(0, 3), [[1, 0], [0, 1]], 2);
        expect(picked.map(c => c.id)).toEqual([1, 2]);
    });
});

describe('nearest', () => {
    it('picks the most similar candidate and skips unembedded ones', () => {
        const best = nearest([1, 0], [
            { id: 'a', embedding: null },
            { id: 'b', embedding: [0, 1] },
            { id: 'c', embedding: [1, 0.1] }
        ]);
        expect(best?.item.id).toBe('c');
    });

    it('returns null when nothing has an embedding', () => {
        expect(nearest([1, 0], [{ embedding: null }])).toBeNull();
    });
});

describe('blobToVector', () => {
    it('reads a float32 blob even at a non-zero byte offset', () => {
        const backing = Buffer.alloc(16);
        const view = backing.subarray(4, 12);
        new Float32Array(view.buffer, view.byteOffset, 2).set([1.5, -2]);
        expect(Array.from(blobToVector(view)!)).toEqual([1.5, -2]);
    });

    it('returns null for an empty or missing blob', () => {
        expect(blobToVector(null)).toBeNull();
        expect(blobToVector(Buffer.alloc(0))).toBeNull();
    });
});
