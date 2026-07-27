import { describe, it, expect } from 'vitest';
import { commitAuthorFor } from './wiki';

/**
 * `commitAuthorFor` turns the signed-in account into the git identity a wiki
 * commit is written under.
 *
 * Every wiki edit used to be committed as a literal "Wiki Editor <wiki@local>",
 * so neither the repository history nor the per-file history panel that reads
 * it could say who changed a page.
 */

describe('commitAuthorFor', () => {
    it('prefers the OIDC display name and email', () => {
        expect(commitAuthorFor({
            username: 'rzatecka',
            display_name: 'Radim Zátěcka',
            email: 'radim.zatecka@skoda-auto.cz'
        })).toEqual({ name: 'Radim Zátěcka', email: 'radim.zatecka@skoda-auto.cz' });
    });

    it('falls back to the username when there is no display name', () => {
        expect(commitAuthorFor({ username: 'admin', display_name: null, email: null }))
            .toEqual({ name: 'admin', email: 'admin@wiki.local' });
    });

    it('synthesises an address whose local part is address-safe', () => {
        // The OIDC callback appends `@oidc-<sub>` when a preferred_username
        // collides with an existing account, so the username itself can hold
        // characters an address may not.
        expect(commitAuthorFor({ username: 'admin@oidc-1a2b3c4d5e6f', display_name: 'Someone Else', email: null }))
            .toEqual({ name: 'Someone Else', email: 'admin-oidc-1a2b3c4d5e6f@wiki.local' });
    });

    it('strips the delimiters that would make the commit object unparseable', () => {
        // A commit is line-oriented and wraps the address in <>; an IdP claim is
        // not trusted to be free of either.
        expect(commitAuthorFor({
            username: 'x',
            display_name: 'Eve <eve@evil.example>\nfaked: header',
            email: 'ok@example.com'
        })).toEqual({ name: 'Eve eve@evil.example faked: header', email: 'ok@example.com' });
    });

    it('uses the placeholder identity only when there is no user at all', () => {
        expect(commitAuthorFor(null)).toEqual({ name: 'Wiki Editor', email: 'wiki@local' });
        expect(commitAuthorFor(undefined)).toEqual({ name: 'Wiki Editor', email: 'wiki@local' });
    });

    it('does not let a whitespace-only display name produce an empty author', () => {
        expect(commitAuthorFor({ username: 'jdoe', display_name: '   ', email: null }))
            .toEqual({ name: 'jdoe', email: 'jdoe@wiki.local' });
    });
});
