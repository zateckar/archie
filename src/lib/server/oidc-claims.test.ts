import { describe, it, expect } from 'vitest';
import { identityClaimsFrom, shouldFetchUserinfo } from './oidc-claims';

/**
 * Which claims name a person, and — the part with teeth — the difference between
 * "no name" and "don't know the name". An access token usually carries fewer
 * claims than a userinfo response, and treating that thinness as fact would blank
 * out the profile the web sign-in stored.
 */

describe('identityClaimsFrom', () => {
    it('reads a full set of claims', () => {
        expect(
            identityClaimsFrom({
                sub: 'abc',
                preferred_username: 'jane.doe',
                name: 'Jane Doe',
                email: 'jane@example.com'
            })
        ).toEqual({ sub: 'abc', preferred_username: 'jane.doe', name: 'Jane Doe', email: 'jane@example.com' });
    });

    it('leaves absent claims undefined rather than null', () => {
        const claims = identityClaimsFrom({ sub: 'abc' });
        expect(claims).toEqual({ sub: 'abc', preferred_username: undefined, name: undefined, email: undefined });
        // The distinction the storage layer keys on: `undefined` must not overwrite.
        expect(claims && 'preferred_username' in claims && claims.preferred_username === undefined).toBe(true);
    });

    it('treats blank strings as absent', () => {
        expect(identityClaimsFrom({ sub: 'abc', preferred_username: '   ', email: '' })).toEqual({
            sub: 'abc',
            preferred_username: undefined,
            name: undefined,
            email: undefined
        });
    });

    it('builds a display name from the split claims when there is no `name`', () => {
        expect(identityClaimsFrom({ sub: 'abc', given_name: 'Jane', family_name: 'Doe' })?.name).toBe('Jane Doe');
        expect(identityClaimsFrom({ sub: 'abc', given_name: 'Jane' })?.name).toBe('Jane');
    });

    it('prefers an explicit name over the split claims', () => {
        expect(
            identityClaimsFrom({ sub: 'abc', name: 'Dr Jane Doe', given_name: 'Jane', family_name: 'Doe' })?.name
        ).toBe('Dr Jane Doe');
    });

    it('is null without a subject, since nothing can be mapped', () => {
        expect(identityClaimsFrom({})).toBeNull();
        expect(identityClaimsFrom({ sub: '' })).toBeNull();
        expect(identityClaimsFrom({ sub: 42 })).toBeNull();
    });
});

describe('shouldFetchUserinfo', () => {
    it('never fetches for a user who already exists', () => {
        expect(shouldFetchUserinfo({ sub: 'abc' }, true)).toBe(false);
    });

    it('fetches before creating an account the token names only by subject id', () => {
        // Otherwise the username in the admin users table would be a raw UUID.
        expect(shouldFetchUserinfo({ sub: 'abc' }, false)).toBe(true);
    });

    it('does not fetch when the token already names the person', () => {
        expect(shouldFetchUserinfo({ sub: 'abc', preferred_username: 'jane.doe' }, false)).toBe(false);
        expect(shouldFetchUserinfo({ sub: 'abc', email: 'jane@example.com' }, false)).toBe(false);
    });
});
