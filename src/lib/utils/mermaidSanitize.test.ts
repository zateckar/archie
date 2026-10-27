import { describe, it, expect } from 'vitest';
import { sanitizeMermaid } from './mermaidSanitize';

describe('sanitizeMermaid — edge labels', () => {
	it('quotes an edge label containing parentheses', () => {
		const out = sanitizeMermaid('flowchart TD\n    P -->|OIDC (Preferred)| O["Configure"]');
		expect(out).toContain('P -->|"OIDC (Preferred)"| O["Configure"]');
	});

	it('leaves plain and already-quoted labels alone', () => {
		const src = 'flowchart TD\n    A -->|SAML| B\n    A -->|"M2M (OIDC)"| C\n';
		expect(sanitizeMermaid(src)).toBe(src);
	});

	it('escapes a stray double quote inside a label', () => {
		const out = sanitizeMermaid('flowchart LR\n    A -.->|say "hi" [x]| B');
		expect(out).toContain('A -.->|"say #quot;hi#quot; [x]"| B');
	});

	it('repairs the reported identity-portal diagram', () => {
		const src = [
			'flowchart TD',
			'    Portal --> Protocol{"Select Protocol"}',
			'    Protocol -->|OIDC (Preferred)| OIDCConfig["Configure OIDC (Ticket RRT10051777)"]',
			'    Protocol -->|SAML| SAMLConfig["Configure SAML"]',
			'    Protocol -->|M2M| M2MConfig["Configure M2M (OIDC only)"]'
		].join('\n');
		const out = sanitizeMermaid(src);
		expect(out).toContain('Protocol -->|"OIDC (Preferred)"| OIDCConfig["Configure OIDC (Ticket RRT10051777)"]');
		expect(out).toContain('Protocol -->|SAML| SAMLConfig["Configure SAML"]');
		expect(sanitizeMermaid(out)).toBe(out);
	});
});
