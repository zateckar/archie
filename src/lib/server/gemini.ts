import 'dotenv/config';
import * as providers from './providers';

// Gemini model ids. These are used as the FALLBACK provider — every model call
// below goes through ./providers, which prefers the custom LiteLLM gateway
// (LLM_* env vars) when configured and transparently falls back to these
// Gemini models otherwise (or on a LiteLLM error).
let apiKey = process.env.GEMINI_API_KEY || '';
const TEXT_MODEL = process.env.TEXT_MODEL || "gemini-3-flash-preview";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "gemini-embedding-2";
const RERANK_MODEL = process.env.RERANK_MODEL || "gemini-3-flash-preview";
const CHUNK_MODEL = process.env.CHUNK_MODEL || "gemini-3-flash-preview";

// If we are in SvelteKit, try to get it from $env
try {
    // @ts-ignore
    const { env } = await import('$env/dynamic/private');
    if (env.GEMINI_API_KEY) apiKey = env.GEMINI_API_KEY;
} catch (e) {
    // Not in SvelteKit environment
}

// ── Sampling configuration ────────────────────────────────────────────────
// Every generateContent() call in this file previously relied on the SDK's
// default sampling settings (temperature ~1.0, free-form text output parsed
// via brittle bracket-matching in parseJSON()). That default is far too high
// for the majority of calls in this pipeline, which are structured
// extraction/classification tasks that want a deterministic, repeatable
// answer, not creative variation — high temperature here directly causes
// paraphrase drift during cleaning (which checkContentPreservation exists
// solely to detect after the fact), unstable topic/claim extraction, and
// inconsistent JSON that fails to parse. `responseMimeType: 'application/json'`
// also asks Gemini to return raw JSON instead of markdown-fenced JSON,
// removing an entire class of parse failures (parseJSON's fence-stripping
// remains as a defensive fallback, not the primary mechanism).
const DETERMINISTIC_JSON_CONFIG = { temperature: 0.1, responseMimeType: 'application/json' };
const RERANK_CONFIG = { temperature: 0, responseMimeType: 'application/json' };
const EXTRACTION_CONFIG = { temperature: 0.15, responseMimeType: 'application/json' };
const REWRITE_CONFIG = { temperature: 0.2 }; // faithful rewriting (cleaning) — free text
const SUMMARY_CONFIG = { temperature: 0.3 }; // summarization — free text
const SYNTHESIS_CONFIG = { temperature: 0.4 }; // briefing synthesis — free text
const CHAT_CONFIG = { temperature: 0.4 }; // final user-facing answer — free text

export async function listModels() {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'X-Goog-Api-Key': apiKey }
    });
    return await res.json();
}

/**
 * Splits `text` into chunks of at most `maxChars`, preferring to break on
 * markdown section headers first and falling back to paragraph boundaries if
 * headers don't produce small-enough sections. Shared by `cleanDocument` and
 * `summarizeDocument` so large-document handling stays consistent between
 * the two LLM preprocessing passes.
 */
export function splitIntoSections(text: string, maxChars: number): string[] {
    const sections = text.split(/(?=\n#{1,3} )/);
    const chunks: string[] = [];
    let currentChunk = '';

    for (const section of sections) {
        if ((currentChunk.length + section.length) > maxChars && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = section;
        } else {
            currentChunk += section;
        }
    }
    if (currentChunk) chunks.push(currentChunk);

    // If section-based splitting didn't work (no headers), split by paragraphs
    if (chunks.length === 1 && chunks[0].length > maxChars) {
        chunks.length = 0;
        currentChunk = '';
        const paragraphs = text.split(/\n\n+/);
        for (const para of paragraphs) {
            if ((currentChunk.length + para.length) > maxChars && currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = para;
            } else {
                currentChunk += (currentChunk ? '\n\n' : '') + para;
            }
        }
        if (currentChunk) chunks.push(currentChunk);
    }

    return chunks;
}

/**
 * Extracts tokens from `text` that are cheap to verify were preserved after
 * an LLM rewrite: numbers/percentages, ISO/slash dates, multi-word proper
 * -noun-looking phrases, and standalone acronyms. These are exactly the kind
 * of detail an LLM "cleaning" pass is most likely to silently drop, garble,
 * or paraphrase away (a specific threshold, a system name, a compliance
 * deadline) while still producing plausible-looking, correctly-shaped prose
 * that passes a pure length check.
 */
// Common sentence-initial words that capitalization rules put at the start of
// many multi-word capitalized matches ("The Test Reliability Engineer...").
// Stripped from the front of a matched phrase before it's treated as a
// "significant token" — otherwise nearly every English sentence produces a
// false-positive "missing" token purely because the LLM rephrased around a
// leading "The"/"This"/etc., drowning out genuinely dropped content in noise.
const LEADING_STOPWORDS = new Set([
    'The', 'This', 'That', 'These', 'Those', 'Each', 'Every', 'All', 'Any',
    'A', 'An', 'It', 'Its', 'They', 'Their', 'Such', 'Both', 'Either'
]);

// Section/outline numbering that cleaning is *supposed* to strip or reformat:
// leading list/heading numbers like "1.", "1.2", "1.2.3", "31.11.1", "52.12."
// (optionally with trailing punctuation), i.e. 2–3 dotted groups. These look
// like "numbers" to a naive extractor but are structural artifacts (TOC entries,
// numbered headings/steps), not substantive content. Counting them as
// "significant tokens" made the preservation check punish the cleaner for doing
// exactly what it was told to do (remove TOC entries / restructure numbering),
// discarding otherwise-good cleaning.
//
// Deliberately limited to 2–3 groups so that 4-group dotted-decimals (IPv4
// addresses like 193.108.108.209) are NOT treated as structural — those are real
// content and must still be verified as preserved.
const SECTION_NUMBERING = /^\d{1,3}(?:\.\d{1,3}){1,2}\.?$/;

// Normalizes a token for a loose "did it survive the rewrite?" comparison:
// lowercased, with commas and surrounding punctuation collapsed so that a value
// re-rendered with different spacing/formatting (e.g. an IP or version number
// beside reformatted markdown) still matches its source rather than being
// falsely reported as dropped.
function normalizeForMatch(token: string): string {
    return token.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Matches lowercase technical tokens the old extractor was completely blind to:
 * identifiers with internal punctuation or mixed letters+digits that a cleaning
 * pass could silently drop or garble while every capitalized/numeric token
 * still survived. Examples: `max_connections`, `utf-8`, `v1.2.3`, `chmod`,
 * `git-rebase`, `.tar.gz`, `0x1F`, `--force`, `api/v2`. These are exactly the
 * high-value content that "numbers + ALLCAPS acronyms + Proper Nouns" misses,
 * so they're treated as HARD tokens (must survive verbatim — cleaning is now
 * deletion-only, so any real technical term either survives untouched or was
 * dropped, and dropping one is real data loss).
 */
const TECHNICAL_TOKEN = /(?:[A-Za-z]+[._/\-][A-Za-z0-9._/\-]*[A-Za-z0-9]|[a-z]+\d[A-Za-z0-9]*|\d+[a-z]+[A-Za-z0-9]*|0x[0-9A-Fa-f]+|--?[a-z][a-z0-9-]+)/g;

/**
 * Significant tokens split into two classes:
 *   - `hard`: numbers, percentages, dates, acronyms, and lowercase technical
 *     identifiers. Cleaning is now deletion + reformatting only (no paraphrase,
 *     no translation), so any of these either survives verbatim or was dropped —
 *     and a drop is a reliable signal of real data loss.
 *   - `soft`: multi-word proper-noun-looking phrases. Useful diagnostics, but
 *     reformatting can legitimately reshape their surrounding punctuation, so
 *     they don't gate the ratio on their own.
 */
function extractSignificantTokens(text: string): { hard: Set<string>; soft: Set<string> } {
    const hard = new Set<string>();
    const soft = new Set<string>();

    // Numbers/percentages, but skip pure section-outline numbering (see above).
    const numberMatches = text.match(/\b\d[\d,.]*%?\b/g) || [];
    for (const n of numberMatches) {
        if (n.replace(/[.,]/g, '').length === 0) continue;
        if (SECTION_NUMBERING.test(n)) continue; // structural, not content
        hard.add(n);
    }

    const dateMatches = text.match(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || [];
    for (const d of dateMatches) hard.add(d);

    const acronyms = text.match(/\b[A-Z]{2,}\b/g) || [];
    for (const a of acronyms) hard.add(a);

    // Lowercase/mixed technical identifiers — previously invisible to the check.
    const techMatches = text.match(TECHNICAL_TOKEN) || [];
    for (const t of techMatches) {
        // Ignore trivially short matches and section numbering that slipped through.
        if (t.length < 3) continue;
        if (SECTION_NUMBERING.test(t)) continue;
        hard.add(t);
    }

    const properNounMatches = text.match(/\b[A-Z][A-Za-z0-9]*(?:[-\s][A-Z][A-Za-z0-9]*){1,3}\b/g) || [];
    for (const raw of properNounMatches) {
        const words = raw.split(/[-\s]+/);
        while (words.length > 1 && LEADING_STOPWORDS.has(words[0])) words.shift();
        const cleaned = words.join(' ');
        if (words.length >= 2 || (words.length === 1 && !LEADING_STOPWORDS.has(words[0]))) {
            soft.add(cleaned);
        }
    }

    return { hard, soft };
}

/**
 * Compares significant tokens found in `original` against `cleaned`, returning
 * what fraction survived and a sample of what's missing. Used as a
 * content-preservation safety net after `cleanDocument` — a pure length check
 * cannot catch a pass that drops a specific number, technical term, or name
 * while otherwise producing plausible, correctly-sized output.
 *
 * The ratio is driven by the `hard` token class (numbers, dates, acronyms, and
 * lowercase technical identifiers). Because cleaning is now deletion +
 * reformatting only (no paraphrase, no translation), a hard token either
 * survives verbatim or was genuinely dropped — so its disappearance is a
 * reliable data-loss signal. `soft` proper-noun tokens are reported in the
 * `missing` sample for diagnostics but do NOT gate the ratio on their own.
 * When a document has no hard tokens at all, soft tokens are used as a fallback.
 */
function checkContentPreservation(original: string, cleaned: string): { preservedRatio: number; missing: string[] } {
    const { hard, soft } = extractSignificantTokens(original);

    // Compare against a normalized copy of the cleaned text so that a value which
    // survived but was re-rendered with different punctuation/spacing (common
    // for IPs, version numbers, and figures next to reformatted markdown) is
    // still counted as preserved rather than falsely flagged as dropped.
    //
    // Matching is boundary-aware rather than a bare substring test: previously
    // `includes("30")` counted "30" as preserved if "300", "2030", or "v3.0"
    // appeared anywhere, over-crediting survival and masking real drops. We pad
    // the haystack with spaces and require the token to sit against a non-alnum
    // boundary on both sides (numbers/words) so "30" no longer matches inside
    // "300", while punctuation-bearing technical tokens (utf-8, v1.2.3) still do.
    const rewrittenNorm = ` ${normalizeForMatch(cleaned)} `;
    const survives = (token: string) => {
        const t = normalizeForMatch(token);
        if (!t) return true;
        const idx = rewrittenNorm.indexOf(t);
        if (idx === -1) return false;
        const isWordChar = (ch: string) => /[a-z0-9]/.test(ch);
        const startsWord = isWordChar(t[0]);
        const endsWord = isWordChar(t[t.length - 1]);
        // Scan every occurrence; accept if any sits on clean boundaries.
        let from = idx;
        while (from !== -1) {
            const before = rewrittenNorm[from - 1] ?? ' ';
            const after = rewrittenNorm[from + t.length] ?? ' ';
            const okBefore = !startsWord || !isWordChar(before);
            const okAfter = !endsWord || !isWordChar(after);
            if (okBefore && okAfter) return true;
            from = rewrittenNorm.indexOf(t, from + 1);
        }
        return false;
    };

    let hardPreserved = 0;
    const missing: string[] = [];
    for (const token of hard) {
        if (survives(token)) hardPreserved++;
        else missing.push(token);
    }
    // Soft tokens: diagnostics only (surfaced in the sample), don't gate the ratio.
    for (const token of soft) {
        if (!survives(token)) missing.push(token);
    }

    // Prefer the hard-token ratio. Fall back to soft tokens only when there are
    // no hard tokens to judge by; if there's nothing to check at all, pass.
    let preservedRatio: number;
    if (hard.size > 0) {
        preservedRatio = hardPreserved / hard.size;
    } else if (soft.size > 0) {
        let softPreserved = 0;
        for (const token of soft) if (survives(token)) softPreserved++;
        preservedRatio = softPreserved / soft.size;
    } else {
        preservedRatio = 1;
    }

    return { preservedRatio, missing };
}

export interface CleanRemoval {
    text: string;
    reason?: string;
    category?: string;
}

export interface CleanResult {
    /** The cleaned document text. */
    text: string;
    /** Structured audit log of spans the cleaner removed, and why. */
    removals: CleanRemoval[];
    /** 'cleaned' = accepted; 'cleaned_flagged' = accepted but some loss detected;
     *  'fell_back' = cleaning was catastrophic, original text kept. */
    verdict: 'cleaned' | 'cleaned_flagged' | 'fell_back';
    /** Fraction of significant source tokens that survived cleaning (0..1). */
    preservedRatio: number;
}

// ── Cleaning verification thresholds ────────────────────────────────────────
// Per the design decision: clean AGGRESSIVELY but only fall back to the raw
// document when cleaning went *catastrophically* wrong — not on mere rewording
// or moderate token loss. Because cleaning is now deletion + reformatting only
// (no paraphrase, no translation), a low preserved-token ratio genuinely means
// real content was dropped, so the two catastrophe signals are:
//   1. The output is a tiny fraction of the input (>50% of *length* gone), OR
//   2. More than half of the source's significant tokens vanished.
// Anything between "perfect" and "catastrophic" is accepted but flagged in the
// audit log for review, rather than discarded.
const CATASTROPHIC_LENGTH_RATIO = 0.5;   // reject if cleaned < 50% of original length
const CATASTROPHIC_TOKEN_LOSS = 0.5;     // reject if < 50% of significant tokens survive
const FLAG_TOKEN_LOSS = 0.9;             // flag (but keep) if < 90% survive

const KNOWN_NOISE_CATEGORIES = new Set([
    'page_number', 'header_footer', 'navigation', 'table_of_contents', 'toc',
    'boilerplate', 'disclaimer', 'metadata', 'pdf_artifact', 'formatting_artifact',
    'placeholder', 'empty_section', 'template_instruction', 'duplicate', 'watermark',
    'line_break_fix', 'whitespace', 'other'
]);

/**
 * Cleans a document by REMOVING non-informational noise and REFORMATTING —
 * never by paraphrasing, summarizing, reordering, or translating. This is a
 * deliberate, conservative contract: everything downstream (chunking,
 * extraction, embeddings, and the text shown to users) depends on this output,
 * so the cleaner is only allowed to *delete* junk and fix *formatting*, using
 * the document's own words verbatim for everything it keeps.
 *
 * Returns a structured result including an audit log of what was removed and a
 * verification verdict. The caller (addDocument) persists this so aggressive
 * removal stays inspectable. Falls back to the original text only when cleaning
 * was catastrophic (see thresholds above), not on ordinary editing.
 */
export async function cleanDocument(text: string): Promise<CleanResult> {
    // Very short documents don't need cleaning
    if (text.length < 200) {
        return { text, removals: [], verdict: 'cleaned', preservedRatio: 1 };
    }

    const buildPrompt = (chunk: string, isPartial: boolean, prevTailContext?: string) => `
        You are a meticulous document cleaner. Your ONLY job is to strip non-informational noise and fix formatting in the following ${isPartial ? 'section of a ' : ''}document. You are NOT an editor or a writer.

        STRICT RULES — follow exactly:
        1. **DELETE noise only**: Remove page numbers, running headers/footers, navigation elements, table-of-contents entries, repeated boilerplate/disclaimers, auto-generated metadata, watermarks, PDF-conversion artifacts, empty/placeholder sections, "TODO"/template instructions, and other content that carries NO informational value.
        2. **FIX formatting**: Repair broken line breaks, de-hyphenate words split across lines, fix garbled unicode, normalize whitespace, and re-apply clean markdown structure (headers, bullet/numbered lists, tables) to content that is already there.
        3. **PRESERVE everything informational VERBATIM**: Every sentence, fact, procedure, policy, requirement, number, date, threshold, name, code snippet, command, parameter, and technical term that carries meaning MUST be kept using the document's OWN WORDS. Do NOT paraphrase, do NOT summarize, do NOT condense, do NOT reword, do NOT reorder content, and do NOT "improve" phrasing.
        4. **DO NOT translate**: Keep the document in its ORIGINAL LANGUAGE. Never translate any content.
        5. **DO NOT invent**: Never add sentences, transitions, topic sentences, or commentary that were not in the source.

        In short: if a line is noise, delete it; if it carries information, keep its exact wording (fixing only formatting). When in doubt whether something is informational, KEEP it.
        ${isPartial ? '\nNote: This is a section of a larger document. Do not add an overall title.' : ''}
        ${prevTailContext ? `\nEND OF THE PREVIOUS SECTION (already cleaned; shown ONLY so heading levels stay consistent — do NOT repeat or continue it):\n"""\n${prevTailContext}\n"""\n` : ''}

        Return ONLY a JSON object of this exact shape:
        {
          "cleaned": "the full cleaned ${isPartial ? 'section' : 'document'} text, preserving all informational content verbatim",
          "removals": [
            {"text": "<the removed span, truncated to ~120 chars>", "reason": "<why it was removed>", "category": "<one of: page_number, header_footer, navigation, table_of_contents, boilerplate, disclaimer, metadata, pdf_artifact, formatting_artifact, placeholder, empty_section, template_instruction, duplicate, watermark, other>"}
          ]
        }
        List every meaningful removal in "removals" (you may omit pure whitespace/line-break fixes). Do not include markdown fences.

        Document${isPartial ? ' section' : ''}:
        ${chunk}
    `;

    interface CleanChunkResponse { cleaned?: string; removals?: CleanRemoval[]; }

    // Runs the cleaning prompt for one chunk and parses the structured response.
    // Returns null on hard failure (LLM error / unparseable) so the caller can
    // retry once before deciding to fall back.
    const cleanOneChunk = async (
        chunk: string,
        isPartial: boolean,
        prevTailContext?: string
    ): Promise<{ cleaned: string; removals: CleanRemoval[] } | null> => {
        try {
            const result = await withRetry(() => providers.generateContent(buildPrompt(chunk, isPartial, prevTailContext), { model: TEXT_MODEL }, DETERMINISTIC_JSON_CONFIG));
            const parsed = tryParseJSON<CleanChunkResponse>(result.response.text());
            if (parsed === undefined || typeof parsed.cleaned !== 'string') return null;
            const removals = Array.isArray(parsed.removals)
                ? parsed.removals
                    .filter((r): r is CleanRemoval => !!r && typeof r.text === 'string')
                    .map(r => ({
                        text: r.text.slice(0, 200),
                        reason: typeof r.reason === 'string' ? r.reason : undefined,
                        category: typeof r.category === 'string' && KNOWN_NOISE_CATEGORIES.has(r.category.toLowerCase())
                            ? r.category.toLowerCase()
                            : 'other'
                    }))
                : [];
            return { cleaned: parsed.cleaned.trim(), removals };
        } catch (e) {
            console.error('[CleanDocument] Cleaning call failed:', e);
            return null;
        }
    };

    // Verifies one cleaned chunk against its source. Returns the accepted text
    // (cleaned or original), a verdict, and the preserved ratio. Only falls back
    // when catastrophic; otherwise accepts (flagging moderate loss).
    const verifyChunk = (
        source: string,
        cleaned: string,
        label: string
    ): { text: string; verdict: 'cleaned' | 'cleaned_flagged' | 'fell_back'; preservedRatio: number } => {
        if (cleaned.length < source.length * CATASTROPHIC_LENGTH_RATIO) {
            console.warn(`[CleanDocument] ${label}: cleaning removed ${Math.round((1 - cleaned.length / source.length) * 100)}% of length (catastrophic) — keeping original.`);
            return { text: source, verdict: 'fell_back', preservedRatio: 0 };
        }
        const { preservedRatio, missing } = checkContentPreservation(source, cleaned);
        if (preservedRatio < CATASTROPHIC_TOKEN_LOSS) {
            console.warn(`[CleanDocument] ${label}: only ${Math.round(preservedRatio * 100)}% of significant tokens survived (catastrophic) — keeping original. Sample missing: ${missing.slice(0, 10).join(', ')}`);
            return { text: source, verdict: 'fell_back', preservedRatio };
        }
        if (preservedRatio < FLAG_TOKEN_LOSS) {
            console.warn(`[CleanDocument] ${label}: ${Math.round(preservedRatio * 100)}% of significant tokens survived (accepted, flagged for review). Sample missing: ${missing.slice(0, 10).join(', ')}`);
            return { text: cleaned, verdict: 'cleaned_flagged', preservedRatio };
        }
        return { text: cleaned, verdict: 'cleaned', preservedRatio };
    };

    // Cleans a chunk with one retry on hard failure, then verifies (with a high
    // fallback bar). Aggregates removals from whichever attempt succeeded.
    const cleanAndVerifyChunk = async (
        chunk: string,
        isPartial: boolean,
        label: string,
        prevTailContext?: string
    ): Promise<{ text: string; verdict: 'cleaned' | 'cleaned_flagged' | 'fell_back'; preservedRatio: number; removals: CleanRemoval[] }> => {
        let attempt = await cleanOneChunk(chunk, isPartial, prevTailContext);
        if (attempt === null) {
            console.warn(`[CleanDocument] ${label}: cleaning failed, retrying once...`);
            attempt = await cleanOneChunk(chunk, isPartial, prevTailContext);
        }
        if (attempt === null) {
            console.error(`[CleanDocument] ${label}: cleaning failed after retry — keeping original chunk.`);
            return { text: chunk, verdict: 'fell_back', preservedRatio: 0, removals: [] };
        }
        const verified = verifyChunk(chunk, attempt.cleaned, label);
        // If we fell back, the removals didn't actually take effect on stored text.
        return {
            ...verified,
            removals: verified.verdict === 'fell_back' ? [] : attempt.removals
        };
    };

    const CHUNK_SIZE = 80000; // ~80K chars per chunk, well within 1M token context

    if (text.length <= CHUNK_SIZE) {
        const r = await cleanAndVerifyChunk(text, false, 'document');
        return { text: r.text, removals: r.removals, verdict: r.verdict, preservedRatio: r.preservedRatio };
    }

    // For large documents: split by section headers, clean each chunk, reassemble
    const chunks = splitIntoSections(text, CHUNK_SIZE);

    console.log(`[CleanDocument] Large document (${text.length} chars), split into ${chunks.length} chunks for cleaning`);

    // Cross-section context: previously each 80K-char section was cleaned in
    // total isolation, which could produce inconsistent heading structure across
    // the reassembled document.
    const PREV_TAIL_CONTEXT_CHARS = 600;
    const cleanedChunks: string[] = [];
    const allRemovals: CleanRemoval[] = [];
    let anyFlagged = false;
    let anyFellBack = false;
    let ratioSum = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const prevTailContext = cleanedChunks.length > 0
            ? cleanedChunks[cleanedChunks.length - 1].slice(-PREV_TAIL_CONTEXT_CHARS)
            : undefined;
        const r = await cleanAndVerifyChunk(chunk, chunks.length > 1, `section ${ci + 1}/${chunks.length}`, prevTailContext);
        cleanedChunks.push(r.text);
        allRemovals.push(...r.removals);
        ratioSum += r.preservedRatio;
        if (r.verdict === 'cleaned_flagged') anyFlagged = true;
        if (r.verdict === 'fell_back') anyFellBack = true;
    }

    const verdict: CleanResult['verdict'] = anyFellBack
        ? 'cleaned_flagged' // some section kept raw — treat whole doc as needing review, not a full failure
        : anyFlagged
            ? 'cleaned_flagged'
            : 'cleaned';

    return {
        text: cleanedChunks.join('\n\n'),
        removals: allRemovals,
        verdict,
        preservedRatio: chunks.length > 0 ? ratioSum / chunks.length : 1
    };
}

const SUMMARY_SECTION_MAX_CHARS = 80000;

/**
 * Generates a comprehensive summary of a document that captures its overall meaning.
 * The summary is stored as metadata and used for better knowledge extraction and search.
 *
 * For documents larger than one context-window-friendly section, this now
 * summarizes each section independently and merges the section summaries
 * into one cohesive final summary, instead of silently truncating at 80K
 * characters (which previously meant the summary — and everything
 * downstream that relies on it, like knowledge extraction's document-context
 * hint — was blind to the back half of any sufficiently large document).
 */
export async function summarizeDocument(text: string, filename: string): Promise<string> {
    if (text.length < 100) return text; // Too short to summarize

    const buildSectionPrompt = (chunk: string, isPartial: boolean) => `
        You are an expert document analyst. Create a comprehensive summary of the following ${isPartial ? 'section of a ' : ''}document that captures its complete meaning and purpose.

        The summary must:
        1. ${isPartial ? "**State what this section covers** in the opening sentence" : "**State the document's purpose and scope** in the opening sentence"}
        2. **Identify all major themes and topics** covered
        3. **Capture key facts, decisions, requirements, and policies** — anything someone might search for
        4. **Note important entities** — people, teams, systems, tools, processes mentioned
        5. **Describe relationships** between concepts discussed
        6. **Preserve important specifics** — dates, thresholds, version numbers, concrete requirements
        7. **Be search-friendly** — use the same terminology as the document so keyword searches will match

        The summary should be 200-500 words depending on ${isPartial ? 'section' : 'document'} complexity.
        Write it as direct factual statements about the subject matter. Do NOT use phrases like "this document describes" or "the document mentions".

        Filename: ${filename}

        Document${isPartial ? ' section' : ''}:
        ${chunk}
    `;

    if (text.length <= SUMMARY_SECTION_MAX_CHARS) {
        try {
            const result = await withRetry(() => providers.generateContent(buildSectionPrompt(text, false), { model: TEXT_MODEL }, SUMMARY_CONFIG));
            return result.response.text().trim();
        } catch (e) {
            console.error('Document summarization failed:', e);
            return '';
        }
    }

    // Large document: summarize each section, then merge into one cohesive summary
    // so the result reflects the WHOLE document instead of just the first 80K chars.
    const sections = splitIntoSections(text, SUMMARY_SECTION_MAX_CHARS);
    console.log(`[SummarizeDocument] Large document (${text.length} chars) for "${filename}" — summarizing ${sections.length} section(s) then merging`);

    const sectionSummaries: string[] = [];
    for (const section of sections) {
        try {
            const result = await withRetry(() => providers.generateContent(buildSectionPrompt(section, sections.length > 1), { model: TEXT_MODEL }, SUMMARY_CONFIG));
            const summary = result.response.text().trim();
            if (summary) sectionSummaries.push(summary);
        } catch (e) {
            console.error(`[SummarizeDocument] Section summary failed for "${filename}":`, e);
        }
    }

    if (sectionSummaries.length === 0) return '';
    if (sectionSummaries.length === 1) return sectionSummaries[0];

    const mergePrompt = `
        You are an expert document analyst. Below are summaries of consecutive sections of a single large document titled "${filename}". Merge them into ONE comprehensive, cohesive summary of the document as a whole.

        The merged summary must:
        1. **State the document's overall purpose and scope** in the opening sentence
        2. **Identify all major themes and topics** across all sections, not just the first
        3. **Capture key facts, decisions, requirements, and policies** from every section — anything someone might search for
        4. **Note important entities** — people, teams, systems, tools, processes mentioned anywhere in the document
        5. **Describe relationships** between concepts, including ones that span multiple sections
        6. **Preserve important specifics** — dates, thresholds, version numbers, concrete requirements — verbatim
        7. **Be search-friendly** — use the same terminology as the document so keyword searches will match
        8. **Remove redundancy** between section summaries; do not just concatenate them

        The merged summary should be 300-700 words depending on overall document complexity.
        Write it as direct factual statements about the subject matter. Do NOT use phrases like "this document describes", "section 1 covers", or "the document mentions".

        Section summaries (in document order):
        ${sectionSummaries.map((s, i) => `[Section ${i + 1}]\n${s}`).join('\n\n')}
    `;

    try {
        const result = await withRetry(() => providers.generateContent(mergePrompt, { model: TEXT_MODEL }, SUMMARY_CONFIG));
        const merged = result.response.text().trim();
        return merged || sectionSummaries.join('\n\n');
    } catch (e) {
        console.error(`[SummarizeDocument] Merge failed for "${filename}", concatenating section summaries:`, e);
        return sectionSummaries.join('\n\n');
    }
}

export async function getEmbedding(text: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_DOCUMENT", title?: string) {
    // Primary: LiteLLM embeddings; fallback: Gemini EMBEDDING_MODEL. The
    // taskType/title retrieval hints are Gemini-specific and only applied on the
    // fallback path (see providers.embedContent).
    const result = await withRetry(() => providers.embedContent(text, { model: EMBEDDING_MODEL }, taskType, title));
    return result.embedding.values;
}

export interface QueryAnalysis {
    needsClarification: boolean;
    clarificationQuestions?: string[];
    searchableQuery: string;
    confidence: 'high' | 'medium' | 'low';
}

export async function analyzeQuery(prompt: string, history: { role: string, content: string }[] = []): Promise<QueryAnalysis> {
    const historyContext = history.length > 0
        ? `Previous conversation:\n${history.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n')}\n\n`
        : '';

    const analysisPrompt = `
        You are a query analyzer for a document search system. Analyze the user's query to determine if it's clear enough to search, or if clarification is needed.

        ${historyContext}User Query: "${prompt}"

        Consider:
        1. Is the query specific enough to find relevant documents?
        2. Are there ambiguous terms that could mean different things?
        3. Is critical context missing (timeframe, system, component, etc.)?
        4. Could the query benefit from narrowing down scope?

        Return ONLY a JSON object:
        {
            "needsClarification": true/false,
            "clarificationQuestions": ["question 1", "question 2"] or null,
            "searchableQuery": "refined query to use for search",
            "confidence": "high/medium/low"
        }

        Rules:
        - Set needsClarification: true ONLY when the query is completely unresolvable without more context — e.g., a bare pronoun with no referent ("how does it work?" with zero conversation history), a single character, or pure gibberish
        - NEVER flag broad-but-valid queries such as "tell me about security", "what are the guidelines", "explain the process", "how does X work" — these should be sent directly to the knowledge graph
        - The bar for clarification is very high; when in doubt, always set needsClarification: false and rely on searchableQuery
        - clarificationQuestions should only appear when the query literally cannot be searched in any meaningful way
        - Always provide a searchableQuery (best guess at user intent)
        - confidence: high if query is specific, medium if somewhat vague, low if very unclear
    `;

    try {
        const result = await withRetry(() => providers.generateContent(analysisPrompt, { model: TEXT_MODEL }, DETERMINISTIC_JSON_CONFIG));
        const text = result.response.text();
        return parseJSON<QueryAnalysis>(text, {
            needsClarification: false,
            searchableQuery: prompt,
            confidence: 'medium'
        });
    } catch (e) {
        console.error('Query analysis failed:', e);
        return {
            needsClarification: false,
            searchableQuery: prompt,
            confidence: 'medium'
        };
    }
}

/**
 * Combines what `analyzeQuery` and `condenseQuery` used to do as two separate
 * sequential LLM calls into one. The chat endpoint needs both — "is this
 * query searchable?" and "what's the standalone search query given history?"
 * — on effectively every turn that isn't a post-clarification retry, so
 * merging them halves a very hot path's LLM round trips without changing
 * behavior. `analyzeQuery` and `condenseQuery` are kept as separate exports
 * for callers that only need one of the two (e.g. the post-clarification
 * retry path only needs condensing).
 */
export async function analyzeAndCondenseQuery(prompt: string, history: { role: string, content: string }[] = []): Promise<QueryAnalysis> {
    const historyContext = history.length > 0
        ? `Previous conversation:\n${history.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n')}\n\n`
        : '';

    const analysisPrompt = `
        You are a query analyzer AND query rewriter for a document search system.

        ${historyContext}User Query: "${prompt}"

        Perform two tasks in one pass:
        1. ANALYZE: decide if the query is clear enough to search, or if clarification is truly required (see rules below).
        2. REWRITE: produce a standalone, search-friendly query that resolves pronouns/references from the conversation history (e.g. "it", "that", "the above") and captures the user's full intent. If the query doesn't depend on history and is already standalone, return it close to as-is.

        Return ONLY a JSON object:
        {
            "needsClarification": true/false,
            "clarificationQuestions": ["question 1", "question 2"] or null,
            "searchableQuery": "standalone, rewritten search query",
            "confidence": "high/medium/low"
        }

        Rules:
        - Set needsClarification: true ONLY when the query is completely unresolvable without more context — e.g., a bare pronoun with no referent ("how does it work?" with zero conversation history), a single character, or pure gibberish
        - NEVER flag broad-but-valid queries such as "tell me about security", "what are the guidelines", "explain the process", "how does X work" — these should be sent directly to the knowledge graph
        - The bar for clarification is very high; when in doubt, always set needsClarification: false and rely on searchableQuery
        - clarificationQuestions should only appear when the query literally cannot be searched in any meaningful way
        - Always provide a searchableQuery (best guess at user intent, standalone from history)
        - confidence: high if query is specific, medium if somewhat vague, low if very unclear
    `;

    try {
        const result = await withRetry(() => providers.generateContent(analysisPrompt, { model: TEXT_MODEL }, DETERMINISTIC_JSON_CONFIG));
        const text = result.response.text();
        return parseJSON<QueryAnalysis>(text, {
            needsClarification: false,
            searchableQuery: prompt,
            confidence: 'medium'
        });
    } catch (e) {
        console.error('Query analysis+condense failed:', e);
        return {
            needsClarification: false,
            searchableQuery: prompt,
            confidence: 'medium'
        };
    }
}

export async function condenseQuery(history: { role: string, content: string }[], prompt: string) {
    if (history.length === 0) return prompt;

    try {
        const condensePrompt = `
            Given the following conversation history and a follow-up question, rephrase the follow-up question to be a standalone search query that captures the user's intent, including any necessary context from the history.
            If the follow-up question is already a standalone question or doesn't depend on history, return it as is.
            Return ONLY the rephrased query.

            History:
            ${history.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n')}

            Follow-up Question: ${prompt}

            Standalone Search Query:
        `;

        const result = await withRetry(() => providers.generateContent(condensePrompt, { model: TEXT_MODEL }, { temperature: 0.1 }));
        const text = result.response.text().trim();
        return text || prompt;
    } catch (e) {
        console.error('Condense query failed:', e);
        return prompt;
    }
}

function buildSystemPrompt(context: string): string {
    const hasContext = context && context.trim().length > 0;
    const hasKnowledge = hasContext && !context.includes('No relevant knowledge found');

    return `You are Archie, a domain expert knowledge assistant.

${hasKnowledge
    ? `KNOWLEDGE BRIEFING:
The following briefing was prepared from a structured knowledge base. Treat every fact in it as verified. Ground your answer in this briefing.

${context}`
    : hasContext
    ? `CONTEXT:\n${context}`
    : 'No relevant knowledge was found for this query. Say so clearly and suggest how the user might rephrase.'}

RESPONSE GUIDELINES:
- Answer the question directly and completely using the briefing above
- Synthesize information across topics; do not just enumerate facts
- State specific details: numbers, dates, thresholds, names — never be vague when the briefing is specific
- If the briefing partially answers the question, deliver what you have and note what's missing
- If the briefing contains contradictions, present both sides with their sources
- Never fabricate information not present in the briefing
- Use markdown: headers for sections, **bold** for key terms, bullet lists for enumerations, tables for comparisons
- Be direct and confident — you are the expert on this topic

DIAGRAMS (Mermaid):
- For processes, architectures, data flows, sequences, state machines, relationships, or hierarchies, include a Mermaid diagram in a fenced code block tagged \`mermaid\`. Example:

\`\`\`mermaid
flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Do thing]
    B -->|No| D[Skip]
\`\`\`

- Supported diagram types: flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap.
- Prefer \`flowchart\` over the legacy \`graph\` syntax. Keep diagrams focused (5–15 nodes). Avoid double-quotes inside node labels — escape with single quotes or omit them. Do not use reserved words (end, default) as node IDs.
- Diagrams enhance text explanations; do not replace prose with diagrams alone.`;
}

export async function synthesizeContext(
    query: string,
    knowledgeContext: string,
    verbatimExcerpts: string,
    conversationSummary?: string
): Promise<string> {
    const prompt = `You are preparing a knowledge briefing for an AI assistant who will answer a user's question. Your job is to transform raw retrieved data into a clear, organized briefing.

USER QUESTION: "${query}"
${conversationSummary ? `\nCONVERSATION CONTEXT: ${conversationSummary}\n` : ''}

RAW RETRIEVED DATA:
${knowledgeContext}

${verbatimExcerpts ? `SOURCE EXCERPTS:\n${verbatimExcerpts}` : ''}

INSTRUCTIONS:
1. Write a concise briefing (300-800 words) that directly addresses the user's question
2. Organize information into coherent paragraphs grouped by sub-topic — do NOT use bullet lists of claims
3. Make cross-topic connections explicit (e.g., "X governs Y, which in turn depends on Z")
4. Drop retrieved facts that are irrelevant to the question
5. Preserve exact figures, dates, names, thresholds, and version numbers verbatim
6. When claims from different topics relate to each other, weave them together narratively
7. Note contradictions or gaps: if the data is incomplete, say what's missing. If a topic section contains a "⚠ Disputed / Unverified" claim, explicitly call out that the knowledge base has conflicting information on that point — state both versions and which source each comes from — rather than silently picking one
8. Cite source documents inline: [filename.md] — but only where you use specific facts from excerpts
9. Write in direct factual prose. Never say "the retrieved data shows" or "according to the claims"
10. If the retrieved data does not contain information relevant to the question, say so in one sentence

OUTPUT FORMAT:
Write the briefing as a knowledge document. Use ## headers for major sub-topics only if the briefing covers multiple distinct areas. Otherwise, write flowing prose paragraphs.`;

    try {
        const result = await withRetry(() => providers.generateContent(prompt, { model: TEXT_MODEL }, SYNTHESIS_CONFIG));
        const synthesized = result.response.text().trim();
        // Safety: if synthesis is suspiciously short vs. input, fall back
        if (synthesized.length < 50 && knowledgeContext.length > 500) {
            console.warn('[Synthesis] Output too short, falling back to raw context');
            return knowledgeContext;
        }
        return synthesized;
    } catch (e) {
        console.error('[Synthesis] Failed, falling back to raw context:', e);
        return knowledgeContext; // Graceful degradation
    }
}

export async function buildConversationBriefing(
    history: { role: string; content: string }[]
): Promise<string> {
    if (history.length < 2) return ''; // No prior context to summarize

    const recentHistory = history.slice(-8); // Last 4 exchanges

    const prompt = `Summarize the key facts, topics, and conclusions established in this conversation so far. Focus on:
1. What specific topics/systems/processes were discussed
2. What facts were established (with specific details)
3. What the user's overall intent or line of inquiry is
4. Any unresolved questions

Conversation:
${recentHistory.map(m => `${m.role}: ${m.content}`).join('\n\n')}

Write a concise summary (100-200 words) in factual prose. Do not include pleasantries or meta-commentary.`;

    try {
        const result = await withRetry(() => providers.generateContent(prompt, { model: TEXT_MODEL }, { temperature: 0.2 }));
        return result.response.text().trim();
    } catch (e) {
        console.error('[ConversationBriefing] Failed:', e);
        return '';
    }
}

export async function chatStream(prompt: string, context: string, history: { role: string, content: string }[] = []) {
    // Returns an async iterable of chunks with a .text() method (LiteLLM primary,
    // Gemini fallback) — matching what the chat endpoint's `for await` loop and
    // its `chunk.text()` call already expect.
    return withRetry(() =>
        providers.startChatStream(prompt, buildSystemPrompt(context), history, { model: TEXT_MODEL }, CHAT_CONFIG)
    );
}

export async function chat(prompt: string, context: string, history: { role: string, content: string }[] = []) {
    const stream = await withRetry(() =>
        providers.startChatStream(prompt, buildSystemPrompt(context), history, { model: TEXT_MODEL }, CHAT_CONFIG)
    );
    let response = '';
    for await (const chunk of stream) {
        response += chunk.text();
    }
    return response;
}

export async function semanticChunk(text: string): Promise<string[]> {
    const prompt = `
        You are an expert document processor. Your task is to split the following text into semantically meaningful chunks.
        Each chunk should represent a distinct topic, concept, or logical section.
        Aim for chunks between 100 and 500 words.
        Return ONLY a valid JSON array of strings, where each string is a chunk.
        Do not include any markdown formatting like \`\`\`json, just the raw array.
        
        Text:
        ${text}
    `;
    try {
        const result = await withRetry(() => providers.generateContent(prompt, { model: CHUNK_MODEL }, DETERMINISTIC_JSON_CONFIG));
        const responseText = result.response.text();
        return parseJSON<string[]>(responseText, []);
    } catch (e) {
        console.error('Semantic chunking failed:', e);
    }
    return [];
}

export interface RelevanceAssessment {
    isRelevant: boolean;
    confidence: 'high' | 'medium' | 'low';
    bestMatchIndex?: number;
    suggestedRefinements?: string[];
}

export async function assessRelevance(query: string, documents: { content: string }[]): Promise<RelevanceAssessment> {
    if (documents.length === 0) {
        return {
            isRelevant: false,
            confidence: 'low',
            suggestedRefinements: ['Try rephrasing your question', 'Add more specific terms', 'Mention the system or component you\'re asking about']
        };
    }

    const prompt = `
        You are a relevance assessor. Determine if the retrieved documents can actually answer the user's query.

        Query: ${query}

        Top 3 Retrieved Chunks:
        ${documents.slice(0, 3).map((doc, i) => `[${i}] ${doc.content.substring(0, 300)}...`).join('\n\n')}

        Assess:
        1. Can these documents answer the query?
        2. How confident are you? (high/medium/low)
        3. Which chunk (index) is most relevant?
        4. If relevance is low, suggest 2-3 query refinements

        Return ONLY a JSON object:
        {
            "isRelevant": true/false,
            "confidence": "high/medium/low",
            "bestMatchIndex": 0-2 or null,
            "suggestedRefinements": ["refinement 1", "refinement 2"] or null
        }
    `;

    try {
        const result = await withRetry(() => providers.generateContent(prompt, { model: RERANK_MODEL }, DETERMINISTIC_JSON_CONFIG));
        const text = result.response.text();
        return parseJSON<RelevanceAssessment>(text, {
            isRelevant: true,
            confidence: 'medium'
        });
    } catch (e) {
        console.error('Relevance assessment failed:', e);
        return { isRelevant: true, confidence: 'medium' };
    }
}

/**
 * Evaluates whether the gathered context is sufficient to answer a user's query.
 * If insufficient, suggests refined queries for a second search pass.
 * Used in the multi-pass RAG pipeline to improve answer quality.
 */
export async function evaluateContext(
    query: string,
    context: string,
): Promise<{ sufficient: boolean; missingAspects: string[]; refinedQueries: string[] }> {
    if (!context || context.includes('No relevant knowledge found')) {
        return {
            sufficient: false,
            missingAspects: ['No relevant information found in the knowledge base'],
            refinedQueries: [query]
        };
    }

    const prompt = `
        You are evaluating whether retrieved context is sufficient to answer a user's question.

        User Query: "${query}"

        Retrieved Context (truncated):
        ${context.substring(0, 8000)}

        Evaluate:
        1. Does the context contain information directly relevant to answering the query?
        2. Are there important aspects of the query that are NOT covered by the context?
        3. If coverage is insufficient, suggest 1-2 alternative search queries that might find the missing information using different terminology or angles.

        Return ONLY a JSON object:
        {
            "sufficient": true/false,
            "missingAspects": ["aspect 1", "aspect 2"] or [],
            "refinedQueries": ["alternative query 1", "alternative query 2"] or []
        }

        Rules:
        - Set sufficient=true if the context covers the main intent of the query, even if not perfectly
        - Set sufficient=false only if the context is clearly off-topic or missing critical information the user asked about
        - refinedQueries should use DIFFERENT terminology or angles than the original query to find complementary information
        - Keep refinedQueries concise and search-friendly
    `;

    try {
        const result = await withRetry(() => providers.generateContent(prompt, { model: RERANK_MODEL }, DETERMINISTIC_JSON_CONFIG));
        const text = result.response.text();
        return parseJSON(text, { sufficient: true, missingAspects: [], refinedQueries: [] });
    } catch (e) {
        console.error('Context evaluation failed:', e);
        return { sufficient: true, missingAspects: [], refinedQueries: [] };
    }
}

// Cap per-chunk content sent into the rerank prompt. Relevance ranking only
// needs enough text to judge topical fit — previously this dumped the FULL,
// untruncated chunk content for up to 20 pooled candidates (searchChunks'
// hybrid-search pool), which could balloon the prompt to tens of thousands
// of characters and risked a truncated/malformed JSON response on the way
// back out. assessRelevance() already truncated to 300 chars for the same
// reason; this brings rerank() in line with that.
const RERANK_CONTENT_PREVIEW_CHARS = 500;

export async function rerank(query: string, documents: { content: string }[]): Promise<number[]> {
    if (documents.length === 0) return [];

    // Primary: LiteLLM's native /rerank endpoint (a real cross-encoder reranker),
    // which returns document indices ordered most→least relevant. Returns null
    // when the gateway/rerank model is unconfigured or errors, in which case we
    // fall back to the LLM-as-reranker prompt below.
    try {
        const nativeRanked = await withRetry(() =>
            providers.rerankDocuments(query, documents.map(d => d.content.substring(0, RERANK_CONTENT_PREVIEW_CHARS)))
        );
        if (nativeRanked) return nativeRanked;
    } catch (e) {
        console.warn('Native rerank failed, falling back to LLM reranker:', (e as Error).message);
    }

    // Fallback: prompt the text model to return ranked indices.
    const prompt = `
        You are an expert reranker. Given a query and a list of document chunks, rank the chunks based on their relevance to the query.
        Return ONLY a JSON array of indices (0-based) in order of relevance, from most relevant to least relevant.
        Do not include any markdown formatting, just the raw JSON array.

        Query: ${query}

        Chunks:
        ${documents.map((doc, i) => `[${i}] ${doc.content.substring(0, RERANK_CONTENT_PREVIEW_CHARS)}`).join('\n\n')}

        Indices:`;

    const identity = documents.map((_, i) => i);
    try {
        const result = await withRetry(() => providers.generateContent(prompt, { model: RERANK_MODEL }, RERANK_CONFIG));
        const text = result.response.text();
        const parsed = parseJSON<unknown>(text, identity);
        // Coerce to an array of indices. OpenAI-compatible gateways in JSON mode
        // (response_format=json_object) cannot return a bare array, so they wrap
        // it in an object like {"indices":[...]} / {"ranking":[...]} / {"result":[...]}.
        // Accept a bare array or the first array-valued property of such an object;
        // otherwise fall back to the original order so callers always get an array.
        const indices = coerceIndexArray(parsed);
        if (indices) return indices;
        console.warn('Reranking returned non-array/unusable shape, using original order.');
    } catch (e) {
        console.error('Reranking failed:', e);
    }

    // Fallback to original order if reranking fails
    return identity;
}

/**
 * Best-effort extraction of a numeric index array from an LLM rerank response.
 * Handles a bare `[...]` array, an object wrapping one (e.g. `{"indices":[...]}`
 * emitted by OpenAI-style JSON mode), and arrays of numeric strings. Returns
 * `null` when no usable array of finite numbers can be found.
 */
function coerceIndexArray(value: unknown): number[] | null {
    const toIndexArray = (arr: unknown[]): number[] | null => {
        const nums = arr
            .map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN))
            .filter((n) => Number.isFinite(n)) as number[];
        return nums.length > 0 ? nums : null;
    };

    if (Array.isArray(value)) return toIndexArray(value);
    if (value && typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) {
            if (Array.isArray(v)) {
                const nums = toIndexArray(v);
                if (nums) return nums;
            }
        }
    }
    return null;
}


export interface ExtractedKnowledge {
    topics: {
        name: string;
        description: string;
        category: string;
    }[];
    claims: {
        topic: string;
        claim: string;
        type?: string;
    }[];
    relationships: {
        source: string;
        target: string;
        type: string;
    }[];
}

/**
 * Closed relationship vocabulary the extractor is asked to use. Kept in sync
 * with `ALLOWED_RELATIONSHIPS` in knowledge.ts; the post-processor maps any
 * out-of-vocabulary value to the closest synonym or drops it.
 */
const RELATIONSHIP_VOCABULARY = [
    'governs', 'depends_on', 'is_part_of', 'is_a', 'manages', 'uses', 'defines',
    'implements', 'complies_with', 'references', 'supports', 'includes',
    'constrains', 'enforces', 'enables'
];

const ALLOWED_CATEGORIES = [
    'Technical', 'Architecture', 'Best Practice', 'Organizational Norm',
    'Process', 'Role', 'Tool', 'Compliance'
];

/**
 * Extracts structured knowledge (topics/claims/relationships) from a document
 * chunk. Returns `null` — not an empty-but-valid result — when the LLM call
 * or JSON parsing genuinely failed, so callers can distinguish "this chunk
 * legitimately had nothing to extract" from "extraction failed and this
 * chunk's knowledge was silently lost." Previously both cases returned the
 * identical `{ topics: [], claims: [], relationships: [] }` shape, which
 * made the `if (!knowledge.topics) continue` guard in processDocumentKnowledge
 * a no-op (an empty array is truthy) — a transient API error or a truncated
 * JSON response would drop a chunk's entire contribution to the knowledge
 * base with nothing but a console.error to show for it.
 */
export async function extractKnowledge(text: string, existingTopicNames: string[] = [], documentSummary?: string): Promise<ExtractedKnowledge | null> {
    const vocabularyHint = existingTopicNames.length > 0
        ? `
        EXISTING CANONICAL TOPICS (reuse these names verbatim whenever the same concept appears; only create a new topic if genuinely absent from this list):
        ${existingTopicNames.map((n) => `- ${n}`).join('\n        ')}
        `
        : '';

    const summaryContext = documentSummary
        ? `
        DOCUMENT CONTEXT (summary of the full document this chunk comes from — use this to understand the broader meaning and correctly scope topics and claims):
        ${documentSummary}
        `
        : '';

    const prompt = `
        You are an expert knowledge engineer. Extract structured knowledge from the following document chunk.
        ${summaryContext}
        ${vocabularyHint}

        The text may include [PRECEDING SECTION] and [FOLLOWING SECTION] markers showing adjacent content for context.
        Extract knowledge ONLY from the [CURRENT SECTION]. Use the adjacent sections solely to:
        - Resolve pronouns and references ("it", "this", "the above")
        - Understand the broader context of claims
        - Avoid creating topics that duplicate what the adjacent sections cover
        - Ensure claim completeness (include qualifiers from nearby text)

        Extract the following:

        1. **Topics**: Key concepts, systems, processes, or entities discussed. For each, provide:
           - name: A clear, specific name (avoid overly generic names like "Security" — prefer "Application Security Policy" or "Network Access Control")
           - description: A 1-2 sentence description capturing what this topic covers
           - category: One of: ${ALLOWED_CATEGORIES.join(', ')}

        2. **Knowledge Claims**: Extract ALL types of factual statements:

           ASSERTION: Positive facts ("X requires Y", "X supports Z")
           NEGATION: Explicit exclusions ("X does NOT support Z", "X is not applicable to Y")
           CONDITION: Facts with qualifiers ("X requires Y ONLY WHEN Z", "X applies IF Y")
           COMPARISON: Relative statements ("X is preferred over Y", "X replaces Y as of date")
           BOUNDARY: Scope limitations ("X applies only to production", "X excludes external users")

           Each claim must:
           - Be SELF-CONTAINED: understandable without the original document
           - Convey ACTIONABLE or IMPORTANT information (not trivial observations)
           - Include SPECIFIC DETAILS: numbers, names, dates, thresholds, tools, roles when present in the text
           - Reference one of the topics you identified

           GOOD claims: "Production deployments require approval from at least two senior engineers", "The data retention policy mandates 7-year retention for financial records", "PostgreSQL 15 is the approved database for all new microservices"
           BAD claims (DO NOT generate): "Security is important", "The system has features", "There are multiple components", "The document describes a process"

           Prioritize NEGATION, CONDITION, and BOUNDARY claims — these are the most valuable because they prevent misunderstandings.

           Aim for 3-10 meaningful claims per substantive section. Prioritize QUALITY over QUANTITY — every claim should carry real information value.

        3. **Relationships**: How topics connect. The "type" MUST be one of: ${RELATIONSHIP_VOCABULARY.join(', ')}. Do not invent other relationship types.

        Return ONLY a valid JSON object:
        {
            "topics": [{"name": "...", "description": "...", "category": "..."}],
            "claims": [{"topic": "...", "claim": "...", "type": "assertion|negation|condition|comparison|boundary"}],
            "relationships": [{"source": "...", "target": "...", "type": "..."}]
        }

        Do not include any markdown formatting.

        Document chunk:
        ${text}
    `;

    try {
        const result = await withRetry(() => providers.generateContent(prompt, { model: TEXT_MODEL }, EXTRACTION_CONFIG));
        const responseText = result.response.text();
        const parsed = tryParseJSON<ExtractedKnowledge>(responseText);
        if (parsed === undefined) {
            console.error('Knowledge extraction failed: could not parse JSON from LLM response.');
            return null;
        }
        // Normalize missing arrays (a technically-valid JSON object that omits
        // a key, e.g. `{}`) to empty arrays so callers don't need null checks
        // on every field — this is a genuine "nothing to extract" result, not
        // a failure, so it still returns a real (non-null) object.
        return {
            topics: parsed.topics ?? [],
            claims: parsed.claims ?? [],
            relationships: parsed.relationships ?? []
        };
    } catch (e) {
        console.error('Knowledge extraction failed:', e);
        return null;
    }
}

/**
 * Incremental taxonomy placement: given new/orphan topics and the existing taxonomy,
 * assigns each orphan to the most appropriate parent topic.
 */
export async function deriveTaxonomyPlacements(
    orphanTopics: { id: number; name: string; description: string; category: string }[],
    existingTaxonomy: { id: number; name: string; category: string; parent_topic_id: number | null }[]
): Promise<{ topicId: number; parentId: number | null }[]> {
    if (orphanTopics.length === 0) return [];

    const taxonomyDesc = existingTaxonomy.length > 0
        ? existingTaxonomy.map(t => `  - id:${t.id} "${t.name}" [${t.category}]${t.parent_topic_id ? ` (child of id:${t.parent_topic_id})` : ' (root)'}`).join('\n')
        : '  (no existing taxonomy — all topics are roots)';

    const orphanDesc = orphanTopics.map(t => `  - id:${t.id} "${t.name}" [${t.category}]: ${t.description || 'no description'}`).join('\n');

    const prompt = `
You are a taxonomy expert organizing IT knowledge topics into a meaningful hierarchy.

EXISTING TAXONOMY (already organized):
${taxonomyDesc}

NEW TOPICS (need placement):
${orphanDesc}

For each new topic, decide:
- Which existing topic (by id) should be its parent? A topic should be a child if it is a specialization, sub-process, component, or subset of the parent.
- If the topic is broad/top-level and doesn't fit under any existing topic, set parentId to null (it becomes a root).
- Do NOT create circular dependencies.
- Prefer shallow hierarchies (max 3-4 levels deep).

Return ONLY a JSON object with an "assignments" array:
{"assignments": [{"topicId": <number>, "parentId": <number|null>}, ...]}

Include an entry for every new topic. Do not include markdown formatting.
    `;

    try {
        const result = await withRetry(() => providers.generateContent(prompt, { model: TEXT_MODEL }, DETERMINISTIC_JSON_CONFIG));
        const responseText = result.response.text();
        return parseJSON<{ topicId: number; parentId: number | null }[]>(responseText, []);
    } catch (e) {
        console.error('Taxonomy placement failed:', e);
        return [];
    }
}

/**
 * Full taxonomy rebuild: reviews ALL topics and produces an optimal hierarchy.
 * Returns parent assignments for every topic.
 */
export async function deriveTaxonomyFull(
    allTopics: { id: number; name: string; description: string; category: string; claimCount: number }[]
): Promise<{ topicId: number; parentId: number | null }[]> {
    if (allTopics.length === 0) return [];

    const results: { topicId: number; parentId: number | null }[] = [];

    // Batch topics to avoid context window limits (~40 per batch)
    const BATCH_SIZE = 40;
    for (let i = 0; i < allTopics.length; i += BATCH_SIZE) {
        const batch = allTopics.slice(i, i + BATCH_SIZE);
        const isFirstBatch = i === 0;

        const topicList = batch.map(t =>
            `  - id:${t.id} "${t.name}" [${t.category}]: ${t.description || 'no description'} (${t.claimCount} claims)`
        ).join('\n');

        // For subsequent batches, include the taxonomy built so far as context
        const priorContext = !isFirstBatch && results.length > 0
            ? `\nALREADY ORGANIZED (from prior batches — you may assign new topics as children of these):\n` +
              results.filter(r => r.parentId === null)
                  .map(r => {
                      const t = allTopics.find(t => t.id === r.topicId);
                      return t ? `  - id:${t.id} "${t.name}" [${t.category}] (root)` : '';
                  }).filter(Boolean).join('\n')
            : '';

        const prompt = `
You are a taxonomy expert organizing IT knowledge topics into a meaningful, well-structured hierarchy.

TOPICS TO ORGANIZE:
${topicList}
${priorContext}

Rules:
1. Group related topics under a common parent. A topic should be a child if it is a specialization, sub-process, component, or subset of the parent.
2. Broad/umbrella topics should be roots (parentId: null).
3. Keep hierarchies shallow — ideally 2-3 levels, max 4.
4. A parent MUST be from the same batch or a prior batch root. Use topic ids.
5. Do NOT create circular dependencies.
6. Preserve reasonable groupings — topics of the same category often (but not always) share a parent.
7. Be stable: if a topic is clearly a root/top-level concept, keep it as root.

Return ONLY a JSON object with an "assignments" array:
{"assignments": [{"topicId": <number>, "parentId": <number|null>}, ...]}

Include an entry for EVERY topic in this batch. Do not include markdown formatting.
        `;

        try {
            const result = await withRetry(() => providers.generateContent(prompt, { model: TEXT_MODEL }, DETERMINISTIC_JSON_CONFIG));
            const responseText = result.response.text();
            const batchResults = parseJSON<{ topicId: number; parentId: number | null }[]>(responseText, []);
            results.push(...batchResults);

            // Guard against malformed/collapsed responses (e.g. a gateway that
            // returned a single object instead of the full array). Any topic in
            // this batch that got no assignment is defaulted to a root so it is
            // never silently dropped from the taxonomy.
            const assigned = new Set(batchResults.map(r => r.topicId));
            const missing = batch.filter(t => !assigned.has(t.id));
            if (missing.length > 0) {
                console.warn(`[Taxonomy] Batch starting at ${i}: ${missing.length}/${batch.length} topics missing from response, defaulting to roots.`);
                for (const t of missing) {
                    results.push({ topicId: t.id, parentId: null });
                }
            }
        } catch (e) {
            console.error(`Taxonomy rebuild failed for batch starting at ${i}:`, e);
            // Fallback: mark these as roots
            for (const t of batch) {
                results.push({ topicId: t.id, parentId: null });
            }
        }
    }

    return results;
}

export async function checkConsistency(newClaim: string, existingClaims: string[]): Promise<{ status: 'unique' | 'duplicate' | 'conflict' | 'update', reason?: string }> {
    if (existingClaims.length === 0) return { status: 'unique' };

    const prompt = `
        You are a consistency checker for a knowledge base.
        Compare the following "New Claim" against a list of "Existing Claims" in the same topic.

        Determine if the New Claim is:
        - **unique**: It provides new information that doesn't overlap with existing claims.
        - **duplicate**: It says the same thing as an existing claim.
        - **conflict**: It contradicts an existing claim.
        - **update**: It provides a more recent or more specific version of an existing claim.

        New Claim: ${newClaim}

        Existing Claims:
        ${existingClaims.map((c, i) => `[${i}] ${c}`).join('\n')}

        Return ONLY a valid JSON object:
        {"status": "unique" | "duplicate" | "conflict" | "update", "reason": "brief explanation"}

        Do not include any markdown formatting.
    `;

    try {
        const result = await withRetry(() => providers.generateContent(prompt, { model: TEXT_MODEL }, DETERMINISTIC_JSON_CONFIG));
        const responseText = result.response.text();
        return parseJSON<{ status: 'unique' | 'duplicate' | 'conflict' | 'update', reason?: string }>(responseText, { status: 'unique' });
    } catch (e) {
        console.error('Consistency check failed:', e);
    }
    return { status: 'unique' };
}

/**
 * Batch version of checkConsistency - checks multiple new claims at once.
 * More efficient than calling checkConsistency repeatedly.
 */
export async function checkConsistencyBatch(
    newClaims: string[],
    existingClaims: string[]
): Promise<{ status: 'unique' | 'duplicate' | 'conflict' | 'update'; reason?: string; claimIndex: number }[]> {
    if (newClaims.length === 0) return [];
    if (existingClaims.length === 0) {
        return newClaims.map((_, index) => ({ status: 'unique', claimIndex: index }));
    }

    const prompt = `
        You are a consistency checker for a knowledge base.
        Compare multiple "New Claims" against a list of "Existing Claims" in the same topic.

        For EACH new claim, determine if it is:
        - **unique**: Provides new information that doesn't overlap with existing claims.
        - **duplicate**: Says the same thing as an existing claim.
        - **conflict**: Contradicts an existing claim.
        - **update**: Provides a more recent or more specific version of an existing claim.

        New Claims:
        ${newClaims.map((c, i) => `[${i}] ${c}`).join('\n')}

        Existing Claims:
        ${existingClaims.map((c, i) => `[E${i}] ${c}`).join('\n')}

        Return ONLY a valid JSON array with one object per new claim:
        [
            {"claimIndex": 0, "status": "unique" | "duplicate" | "conflict" | "update", "reason": "brief explanation"},
            {"claimIndex": 1, "status": "unique", "reason": "..."},
            ...
        ]

        Do not include any markdown formatting.
    `;

    try {
        const result = await withRetry(() => providers.generateContent(prompt, { model: TEXT_MODEL }, DETERMINISTIC_JSON_CONFIG));
        const responseText = result.response.text();
        const parsed = parseJSON<{ status: 'unique' | 'duplicate' | 'conflict' | 'update'; reason?: string; claimIndex: number }[]>(
            responseText,
            newClaims.map((_, index) => ({ status: 'unique', claimIndex: index }))
        );

        // Ensure we have results for all claims
        if (parsed.length !== newClaims.length) {
            console.warn(`Batch consistency check returned ${parsed.length} results for ${newClaims.length} claims`);
            // Fill in missing indices with 'unique' status
            for (let i = 0; i < newClaims.length; i++) {
                if (!parsed.find(p => p.claimIndex === i)) {
                    parsed.push({ status: 'unique', claimIndex: i });
                }
            }
        }

        return parsed;
    } catch (e) {
        console.error('Batch consistency check failed:', e);
        return newClaims.map((_, index) => ({ status: 'unique', claimIndex: index }));
    }
}


async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
    try {
        return await fn();
    } catch (e: any) {
        if (retries > 0 && (e.status === 503 || e.status === 429 || e.message?.includes('503') || e.message?.includes('429'))) {
            console.warn(`API error, retrying in ${delay}ms... (${retries} retries left)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return withRetry(fn, retries - 1, delay * 2);
        }
        throw e;
    }
}

/**
 * Core JSON extraction logic, returning `undefined` on failure instead of a
 * fallback value. Callers that need to distinguish "the LLM call/parse
 * genuinely failed" from "the LLM legitimately returned an empty-but-valid
 * result" (e.g. extractKnowledge — see its call site) should use this
 * directly rather than `parseJSON`, which collapses both cases into the same
 * fallback and makes them indistinguishable downstream.
 */
function tryParseJSON<T>(text: string): T | undefined {
    try {
        // Clean up markdown code blocks if present
        const cleaned = text.replace(/```json\n?/, '').replace(/\n?```/, '').trim();

        // Try to find the first [ or { and the last ] or }
        const startBracket = cleaned.indexOf('[');
        const startBrace = cleaned.indexOf('{');

        let start = -1;
        let end = -1;

        if (startBracket !== -1 && (startBrace === -1 || startBracket < startBrace)) {
            start = startBracket;
            end = cleaned.lastIndexOf(']');
        } else if (startBrace !== -1) {
            start = startBrace;
            end = cleaned.lastIndexOf('}');
        }

        if (start !== -1 && end !== -1 && end > start) {
            const jsonStr = cleaned.substring(start, end + 1);
            try {
                return JSON.parse(jsonStr);
            } catch (e) {
                // If it's an unterminated string or similar, try to fix it?
                // For now, just log and report failure.
                console.error('JSON parse error after extraction:', e, 'JSON string:', jsonStr.substring(0, 100) + '...');
            }
        } else {
            // Try parsing the whole thing as a last resort
            return JSON.parse(cleaned);
        }
    } catch (e) {
        console.error('Failed to parse JSON from LLM response:', e, 'Raw text:', text.substring(0, 100) + '...');
    }
    return undefined;
}

function parseJSON<T>(text: string, fallback: T): T {
    const parsed = tryParseJSON<T>(text);
    if (parsed === undefined) return fallback;

    // OpenAI-compatible gateways (LiteLLM primary) in JSON mode
    // (response_format=json_object) CANNOT return a top-level JSON array — they
    // wrap it in an object, e.g. a prompt asking for `["a","b"]` comes back as
    // `{"chunks":["a","b"]}` and one asking for `[{...}]` as a single `{...}` or
    // `{"results":[{...}]}`. When the CALLER expects an array (its fallback is an
    // array) but we parsed an object, transparently unwrap the object's single
    // array-valued property so array-returning callers (semanticChunk,
    // checkConsistencyBatch, deriveTaxonomy*, rerank fallback, …) keep working
    // regardless of provider. Gemini returns bare arrays and is unaffected.
    if (Array.isArray(fallback) && !Array.isArray(parsed) && parsed && typeof parsed === 'object') {
        const arrayProps = Object.values(parsed as Record<string, unknown>).filter(Array.isArray);
        if (arrayProps.length === 1) {
            return arrayProps[0] as T;
        }
        // A lone wrapped object that should have been a single-element array
        // (e.g. batch consistency returning one `{claimIndex,status}` object).
        console.warn('[parseJSON] Expected array but got object; wrapping single object into a one-element array.');
        return [parsed] as unknown as T;
    }

    return parsed;
}
