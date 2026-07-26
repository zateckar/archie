import { describe, it, expect } from 'vitest';
import { normalizeTopicName, foldDiacritics } from './topic-normalize';

const key = (name: string) => normalizeTopicName(name).key;
const display = (name: string) => normalizeTopicName(name).displayName;

describe('foldDiacritics', () => {
    it('folds Czech letters to their ASCII base', () => {
        expect(foldDiacritics('ěščřžýáíéůúňťď')).toBe('escrzyaieuuntd');
        expect(foldDiacritics('ĚŠČŘŽÝÁÍÉŮÚŇŤĎ')).toBe('ESCRZYAIEUUNTD');
    });

    it('folds letters that NFD leaves undecomposed', () => {
        expect(foldDiacritics('Straße')).toBe('Strasse');
        expect(foldDiacritics('Łódź')).toBe('Lodz');
    });

    it('leaves plain ASCII untouched', () => {
        expect(foldDiacritics('IT-PEP Release 2.0')).toBe('IT-PEP Release 2.0');
    });

    it('passes through scripts it cannot fold', () => {
        // Non-Latin text has no ASCII base to fall back to; it must survive the
        // fold so `normalizeTopicName` can decide what to do with it.
        expect(foldDiacritics('数据治理')).toBe('数据治理');
    });
});

describe('normalizeTopicName — Czech corpus', () => {
    it('keys a diacritic spelling and its ASCII spelling identically', () => {
        // The regression this whole change exists for: these are the same
        // concept typed two ways and must share one canonical_key.
        expect(key('Řízení projektů')).toBe(key('Rizeni projektu'));
        expect(key('Řízení projektů')).toBe('rizeni projektu');
    });

    it('preserves the identity of accented words in the key', () => {
        // Previously `[^a-z0-9 ]` deleted the accented characters outright,
        // collapsing these to "zen" and "een".
        expect(key('Řízení')).toBe('rizeni');
        expect(key('Řešení')).toBe('reseni');
    });

    it('does not collide unrelated accented topics', () => {
        expect(key('Řízení')).not.toBe(key('Řešení'));
        expect(key('Bezpečnost')).not.toBe(key('Bezpečnostní audit'));
    });

    it('keeps diacritics in the human-facing display name', () => {
        expect(display('Řízení projektů')).toBe('Řízení projektů');
    });
});

describe('normalizeTopicName — existing behaviour is preserved', () => {
    it('collapses hyphen, space and underscore variants', () => {
        expect(key('IT-PEP')).toBe('it pep');
        expect(key('IT PEP')).toBe('it pep');
        expect(key('IT_PEP')).toBe('it pep');
    });

    it('unifies unicode dashes', () => {
        expect(key('IT‑PEP')).toBe(key('IT-PEP'));
        expect(key('IT—PEP')).toBe(key('IT-PEP'));
    });

    it('strips parenthetical aliases from the key but not the display name', () => {
        expect(key('AMS (Application Management Service)')).toBe('ams');
        expect(display('AMS (Application Management Service)')).toBe(
            'AMS (Application Management Service)'
        );
    });

    it('strips trailing categorical suffixes', () => {
        expect(key('Change Management Process')).toBe('change management');
        expect(key('Security Policy')).toBe('security');
        expect(display('Security Policy')).toBe('Security');
    });

    it('is case-insensitive on the key', () => {
        expect(key('release management')).toBe(key('Release Management'));
    });

    it('handles empty and whitespace-only input', () => {
        expect(normalizeTopicName('')).toEqual({ displayName: '', key: '' });
        expect(normalizeTopicName('   ')).toEqual({ displayName: '', key: '' });
    });

    it('falls back to the lowercased display name when folding empties the key', () => {
        // A name with no Latin characters at all folds to an empty key; the
        // fallback keeps it addressable rather than colliding every such topic
        // on the empty string.
        expect(key('数据治理')).toBe('数据治理');
    });
});
