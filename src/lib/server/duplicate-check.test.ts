import { describe, it, expect } from 'vitest';
import { normalizeForDuplicateCheck } from './knowledge';

/**
 * This key decides whether two claims extracted from the same chunk are treated
 * as duplicates. The old version stripped with the ASCII-only `\w` class and an
 * EMPTY replacement, which deleted accented letters and glued the survivors
 * together — under-normalising, the opposite of the function's purpose.
 */
describe('normalizeForDuplicateCheck', () => {
    it('folds diacritics instead of deleting the letters', () => {
        // Old behaviour: 'bezpenostn', 'schvlen', 'zen', 'ad'.
        expect(normalizeForDuplicateCheck('bezpečnostní')).toBe('bezpecnostni');
        expect(normalizeForDuplicateCheck('schválení')).toBe('schvaleni');
        expect(normalizeForDuplicateCheck('řízení')).toBe('rizeni');
        expect(normalizeForDuplicateCheck('úřad')).toBe('urad');
    });

    it('gives the same key to the same claim written with and without diacritics', () => {
        // The actual production failure: both were inserted, embedded, and later
        // retrieved into one answer as two independent facts.
        const withDiacritics = normalizeForDuplicateCheck('Řízení musí být schváleno.');
        const without = normalizeForDuplicateCheck('Rizeni musi byt schvaleno.');
        expect(withDiacritics).toBe(without);
        expect(withDiacritics).toBe('rizeni musi byt schvaleno');
    });

    it('is independent of Unicode encoding form', () => {
        // Previously NFC and NFD of the same visible string keyed differently, so
        // the key depended on how the markdown happened to be saved.
        const text = 'Řízení musí být schváleno.';
        expect(normalizeForDuplicateCheck(text.normalize('NFC')))
            .toBe(normalizeForDuplicateCheck(text.normalize('NFD')));
    });

    it('replaces punctuation with a space so deletion cannot glue words together', () => {
        expect(normalizeForDuplicateCheck('řízení,projektů')).toBe('rizeni projektu');
    });

    it('still collapses whitespace and case', () => {
        expect(normalizeForDuplicateCheck('  ŘÍZENÍ   Projektů  ')).toBe('rizeni projektu');
    });

    it('keeps digits', () => {
        expect(normalizeForDuplicateCheck('Norma ČSN EN ISO 9001 platí.')).toBe('norma csn en iso 9001 plati');
    });

    it('no longer merges distinct short words to the same key', () => {
        // 'má' and 'mě' both keyed to 'm' before, so claims differing only in
        // those tokens collapsed and one was dropped.
        expect(normalizeForDuplicateCheck('má')).not.toBe(normalizeForDuplicateCheck('mě'));
    });
});
