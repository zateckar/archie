/**
 * Best-effort repair of common syntax mistakes in LLM-generated Mermaid source.
 *
 * An LLM can never be *guaranteed* to emit valid Mermaid, so this is our
 * defense-in-depth layer: before (or after) mermaid tries to parse the source,
 * we run these deterministic, conservative fixes to turn the most frequent
 * mistakes into valid syntax.
 *
 * Design rules:
 *  - Pure function, no DOM — fully unit-testable.
 *  - Conservative: only touch patterns that are *always* wrong in Mermaid.
 *    When in doubt, leave the source untouched and let mermaid report the error.
 *  - Idempotent: running twice yields the same result.
 *
 * Covers the real-world errors we've observed, e.g.:
 *   - `subgraph Id[Title]`            -> `subgraph Id["Title"]`
 *   - `A -x B`  / `A -o B`            -> `A --x B` / `A --o B`
 *   - chained links `A --x B --x C`   -> split onto separate statements
 *   - reserved word `end` used as id  -> renamed
 *   - unbalanced brackets in labels   -> best-effort balancing
 */

/** Fenced-code diagram-type keywords Mermaid understands on the first line. */
const DIAGRAM_HEADERS = [
	'flowchart',
	'graph',
	'sequenceDiagram',
	'classDiagram',
	'stateDiagram-v2',
	'stateDiagram',
	'erDiagram',
	'gantt',
	'mindmap',
	'journey',
	'pie',
	'gitGraph',
	'timeline',
	'quadrantChart',
	'requirementDiagram',
	'C4Context',
	'sankey-beta',
	'xychart-beta',
	'block-beta'
];

/**
 * Repair common mistakes in Mermaid source. Returns the (possibly) fixed source.
 * Safe to call on already-valid source (idempotent, conservative).
 */
export function sanitizeMermaid(input: string): string {
	if (!input) return input;

	let src = normalizeWhitespace(input);
	src = stripCodeFences(src);

	const header = detectHeader(src);
	// Only the flowchart/graph family uses the node/link syntax these fixes target.
	// Other diagram types (sequence, gantt, ...) are left untouched to avoid corruption.
	const isFlowchart = header === 'flowchart' || header === 'graph';

	if (isFlowchart) {
		src = fixSubgraphTitles(src);
		src = fixArrowOperators(src);
		src = splitChainedLinks(src);
		src = renameReservedIds(src);
		src = balanceLabelBrackets(src);
	}

	return src.trim() + '\n';
}

/** Normalize line endings and tabs; trim trailing whitespace per line. */
function normalizeWhitespace(src: string): string {
	return src
		.replace(/\r\n?/g, '\n')
		.replace(/\t/g, '    ')
		.split('\n')
		.map((l) => l.replace(/\s+$/, ''))
		.join('\n');
}

/** Strip a stray ```mermaid ... ``` fence if one slipped into the source. */
function stripCodeFences(src: string): string {
	return src
		.replace(/^\s*```(?:mermaid)?\s*\n/i, '')
		.replace(/\n```\s*$/i, '')
		.trim();
}

/** Detect the diagram type from the first non-empty, non-directive line. */
function detectHeader(src: string): string | null {
	for (const raw of src.split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		// Skip front-matter / directives like %%{init: ...}%% or %% comments.
		if (line.startsWith('%%')) continue;
		if (line.startsWith('---')) continue;
		for (const h of DIAGRAM_HEADERS) {
			if (line === h || line.startsWith(h + ' ') || line.startsWith(h + '\t')) {
				// Normalize `graph`->itself; report the matched keyword's family.
				if (h === 'flowchart' || h === 'graph') return h === 'graph' ? 'graph' : 'flowchart';
				return h;
			}
		}
		return null;
	}
	return null;
}

/**
 * `subgraph Id[Title]` / `subgraph Id (Title)` -> `subgraph Id["Title"]`.
 * Mermaid subgraph titles must be quoted strings, not node-shape syntax.
 * Also quotes bare titles that contain spaces/special chars.
 */
function fixSubgraphTitles(src: string): string {
	return src
		.split('\n')
		.map((line) => {
			const m = line.match(/^(\s*)subgraph\s+(.+?)\s*$/);
			if (!m) return line;
			const indent = m[1];
			let rest = m[2];

			// Already `Id["..."]` or `"..."` — leave alone.
			// Case: Id[Title] or Id(Title) or Id{Title}
			const shaped = rest.match(/^([A-Za-z0-9_-]+)\s*[[({]\s*(.+?)\s*[\])}]\s*$/);
			if (shaped) {
				const id = shaped[1];
				const title = stripQuotes(shaped[2]);
				return `${indent}subgraph ${id}["${title}"]`;
			}

			// Case: bare `subgraph Some Title With Spaces` (no id/brackets, unquoted).
			// A valid bare form is a single token id. If it has spaces and no quotes,
			// wrap it as a quoted title with a derived id.
			if (!/["[\]{}()]/.test(rest) && /\s/.test(rest)) {
				const id = slugify(rest);
				return `${indent}subgraph ${id}["${rest}"]`;
			}

			return line;
		})
		.join('\n');
}

/**
 * Normalize single-dash arrow operators to valid two-dash forms:
 *   `-x`  -> `--x`   (cross end)
 *   `-o`  -> `--o`   (circle end)
 * Only applies when surrounded by spaces (i.e. used as a link), so we don't
 * touch identifiers like `foo-x-bar`.
 */
function fixArrowOperators(src: string): string {
	return src
		.split('\n')
		.map((line) => {
			if (isNonLinkLine(line)) return line;
			// ` -x ` -> ` --x `, ` -o ` -> ` --o ` (not already `--x`/`--o`)
			return line
				.replace(/(^|[^-])\s-x\s/g, '$1 --x ')
				.replace(/(^|[^-])\s-o\s/g, '$1 --o ');
		})
		.join('\n');
}

/**
 * Split chained flowchart links onto separate statements.
 * Mermaid does support chaining, but LLMs frequently produce forms that break
 * the parser (e.g. mixed arrow types, cross/circle chains). We split on every
 * link operator that is preceded by a node token so each edge is its own line.
 *
 * `A --x B --x C`  -> `A --x B\n    B --x C`
 * `A --> B --> C`  -> `A --> B\n    B --> C`
 *
 * Conservative: only splits when there are 2+ link operators on one line and
 * the segments between them look like simple node references (word or word[..]).
 */
function splitChainedLinks(src: string): string {
	// Matches a link operator: -->, -.->, ==>, --x, --o, -.-, ---, etc. with
	// optional |label| or text between dashes.
	const linkOp = /\s(--+[>xo]?|-\.-+>?|==+>?|--x|--o)(\|[^|]*\|)?\s/g;

	const out: string[] = [];
	for (const line of src.split('\n')) {
		if (isNonLinkLine(line)) {
			out.push(line);
			continue;
		}

		const ops = [...line.matchAll(linkOp)];
		if (ops.length < 2) {
			out.push(line);
			continue;
		}

		const indent = line.match(/^\s*/)?.[0] ?? '';
		// Tokenize into [node, op, node, op, node ...]
		const parts = splitByLink(line.trim());
		if (parts.nodes.length !== parts.ops.length + 1 || parts.nodes.length < 3) {
			out.push(line);
			continue;
		}
		for (let i = 0; i < parts.ops.length; i++) {
			const left = i === 0 ? parts.nodes[0] : nodeId(parts.nodes[i]);
			const right = parts.nodes[i + 1];
			out.push(`${indent}${left} ${parts.ops[i]} ${right}`);
		}
	}
	return out.join('\n');
}

/** Split a single flowchart statement into node segments and link operators. */
function splitByLink(stmt: string): { nodes: string[]; ops: string[] } {
	const linkOp = /\s(--+[>xo]?|-\.-+>?|==+>?|--x|--o)(\|[^|]*\|)?\s/g;
	const nodes: string[] = [];
	const ops: string[] = [];
	let lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = linkOp.exec(stmt)) !== null) {
		nodes.push(stmt.slice(lastIndex, m.index).trim());
		ops.push((m[1] + (m[2] ?? '')).trim());
		lastIndex = m.index + m[0].length;
	}
	nodes.push(stmt.slice(lastIndex).trim());
	return { nodes, ops };
}

/** Extract just the node id from a `Id[Label]` / `Id(Label)` / `Id` token. */
function nodeId(token: string): string {
	const m = token.match(/^([A-Za-z0-9_-]+)/);
	return m ? m[1] : token;
}

/**
 * Rename node ids that collide with Mermaid reserved words (`end`, `default`,
 * `subgraph`, etc.). We only rename bare identifier ids, and rewrite every
 * occurrence on that line's word boundary.
 */
const RESERVED_IDS = new Set(['end', 'default', 'subgraph', 'class', 'click', 'style', 'graph']);

function renameReservedIds(src: string): string {
	const lines = src.split('\n');
	const renames = new Map<string, string>();

	// First pass: find reserved ids used as node ids (followed by a shape bracket
	// or a link operator).
	for (const line of lines) {
		if (isNonLinkLine(line)) continue;
		const idMatches = line.matchAll(/\b([A-Za-z]+)\b(?=\s*[[({]|\s+--|\s+-\.|\s+==)/g);
		for (const m of idMatches) {
			const id = m[1];
			if (RESERVED_IDS.has(id.toLowerCase()) && !renames.has(id)) {
				renames.set(id, id + '_node');
			}
		}
	}

	if (renames.size === 0) return src;

	return lines
		.map((line) => {
			if (line.trim().startsWith('subgraph')) return line; // don't touch the keyword
			let out = line;
			for (const [from, to] of renames) {
				// Replace whole-word ids only, avoiding text inside quotes/labels is
				// hard here; keep it to word boundaries which is safe for bare ids.
				out = out.replace(new RegExp(`\\b${escapeRegExp(from)}\\b(?!["\\w])`, 'g'), to);
			}
			return out;
		})
		.join('\n');
}

/**
 * Best-effort balancing of bracket pairs inside node labels so a stray missing
 * closer doesn't blow up the whole parse. Only fixes an obvious single missing
 * closing bracket at end of a statement.
 */
function balanceLabelBrackets(src: string): string {
	return src
		.split('\n')
		.map((line) => {
			if (isNonLinkLine(line)) return line;
			const opens = (line.match(/\[/g) || []).length;
			const closes = (line.match(/\]/g) || []).length;
			if (opens === closes + 1) return line + ']';
			return line;
		})
		.join('\n');
}

/** Lines that are comments, directives, blank, or the diagram header. */
function isNonLinkLine(line: string): boolean {
	const t = line.trim();
	if (!t) return true;
	if (t.startsWith('%%')) return true;
	if (t.startsWith('---')) return true;
	if (/^(flowchart|graph)\b/.test(t)) return true;
	// Standalone subgraph closer only — `end[Finish]` / `end --> A` is a real node.
	if (t === 'end') return true;
	if (/^(subgraph|classDef|style|click|linkStyle|direction)\b/.test(t)) return true;
	return false;
}

function stripQuotes(s: string): string {
	return s.replace(/^["']/, '').replace(/["']$/, '');
}

function slugify(s: string): string {
	return (
		s
			.trim()
			.replace(/[^A-Za-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '') || 'sg'
	);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
