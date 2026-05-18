import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

const genAI = new GoogleGenerativeAI(apiKey);

export async function listModels() {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'X-Goog-Api-Key': apiKey }
    });
    return await res.json();
}

/**
 * Cleans and restructures a document using LLM.
 * Removes noise, improves formatting, creates logical structure.
 * For large documents, splits into chunks and processes each.
 * Always uses LLM — no regex fallback.
 */
export async function cleanDocument(text: string): Promise<string> {
    // Very short documents don't need cleaning
    if (text.length < 200) return text;

    const model = genAI.getGenerativeModel({ model: TEXT_MODEL });

    const buildPrompt = (chunk: string, isPartial: boolean) => `
        You are an expert document editor and preprocessor. Transform the following ${isPartial ? 'section of a ' : ''}document into a clean, well-structured, professional version:

        1. **Remove noise**: Strip boilerplate headers/footers, navigation elements, page numbers, repetitive disclaimers, auto-generated metadata, table of contents entries, and formatting artifacts.
        2. **Remove valueless content**: Remove empty sections, placeholder text, "TODO" markers, template instructions, and content that carries no informational value.
        3. **Restructure for clarity**: Organize content into logical sections with clear markdown headers (##, ###). Group related information together. Ensure a coherent logical flow from general concepts to specific details.
        4. **Improve formatting**: Use proper markdown throughout — headers for sections, bullet lists for enumerations, numbered lists for sequential steps/procedures, tables for structured data, bold for key terms and definitions. Fix broken line breaks, garbled unicode, and normalize whitespace.
        5. **Enhance readability**: Write clear topic sentences for sections. Ensure paragraphs flow logically. Break up walls of text into digestible chunks.
        6. **Preserve ALL substantive content**: Every meaningful fact, procedure, policy, requirement, technical detail, and piece of knowledge must be preserved. Do NOT omit, summarize, or condense any information.
        7. **Standardize to English**: If the document is in any language other than English, translate all content to English while preserving the original meaning, terminology, and technical accuracy. If the document is already in English, keep it as-is.

        The output must be a polished, well-organized markdown document written entirely in English with the same informational content but significantly improved structure and readability.
        ${isPartial ? '\nNote: This is a section of a larger document. Maintain coherent structure within this section and do not add an overall title.' : ''}

        Document${isPartial ? ' section' : ''}:
        ${chunk}
    `;

    const CHUNK_SIZE = 80000; // ~80K chars per chunk, well within 1M token context

    if (text.length <= CHUNK_SIZE) {
        // Single pass for normal-sized documents
        try {
            const result = await withRetry(() => model.generateContent(buildPrompt(text, false)));
            const cleaned = result.response.text().trim();
            // Safety: if cleaning removed more than 90% of content, something went wrong
            if (cleaned.length < text.length * 0.1) {
                console.warn(`[CleanDocument] Cleaning removed ${Math.round((1 - cleaned.length / text.length) * 100)}% of content — using original`);
                return text;
            }
            return cleaned;
        } catch (e) {
            console.error('Document cleaning failed:', e);
            return text;
        }
    }

    // For large documents: split by section headers, clean each chunk, reassemble
    const sections = text.split(/(?=\n#{1,3} )/);
    const chunks: string[] = [];
    let currentChunk = '';

    for (const section of sections) {
        if ((currentChunk.length + section.length) > CHUNK_SIZE && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = section;
        } else {
            currentChunk += section;
        }
    }
    if (currentChunk) chunks.push(currentChunk);

    // If section-based splitting didn't work (no headers), split by paragraphs
    if (chunks.length === 1 && chunks[0].length > CHUNK_SIZE) {
        chunks.length = 0;
        currentChunk = '';
        const paragraphs = text.split(/\n\n+/);
        for (const para of paragraphs) {
            if ((currentChunk.length + para.length) > CHUNK_SIZE && currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = para;
            } else {
                currentChunk += (currentChunk ? '\n\n' : '') + para;
            }
        }
        if (currentChunk) chunks.push(currentChunk);
    }

    console.log(`[CleanDocument] Large document (${text.length} chars), split into ${chunks.length} chunks for cleaning`);

    const cleanedChunks: string[] = [];
    for (const chunk of chunks) {
        try {
            const result = await withRetry(() => model.generateContent(buildPrompt(chunk, chunks.length > 1)));
            const cleaned = result.response.text().trim();
            cleanedChunks.push(cleaned || chunk);
        } catch (e) {
            console.error(`[CleanDocument] Chunk cleaning failed, using original chunk:`, e);
            cleanedChunks.push(chunk);
        }
    }

    return cleanedChunks.join('\n\n');
}

/**
 * Generates a comprehensive summary of a document that captures its overall meaning.
 * The summary is stored as metadata and used for better knowledge extraction and search.
 */
export async function summarizeDocument(text: string, filename: string): Promise<string> {
    if (text.length < 100) return text; // Too short to summarize

    const model = genAI.getGenerativeModel({ model: TEXT_MODEL });
    // For very large documents, truncate to fit model context
    const truncatedText = text.length > 80000
        ? text.substring(0, 80000) + '\n\n[Document truncated for summarization]'
        : text;

    const prompt = `
        You are an expert document analyst. Create a comprehensive summary of the following document that captures its complete meaning and purpose.

        The summary must:
        1. **State the document's purpose and scope** in the opening sentence
        2. **Identify all major themes and topics** covered
        3. **Capture key facts, decisions, requirements, and policies** — anything someone might search for
        4. **Note important entities** — people, teams, systems, tools, processes mentioned
        5. **Describe relationships** between concepts discussed
        6. **Preserve important specifics** — dates, thresholds, version numbers, concrete requirements
        7. **Be search-friendly** — use the same terminology as the document so keyword searches will match

        The summary should be 200-500 words depending on document complexity.
        Write it as direct factual statements about the subject matter. Do NOT use phrases like "this document describes" or "the document mentions".

        Filename: ${filename}

        Document:
        ${truncatedText}
    `;

    try {
        const result = await withRetry(() => model.generateContent(prompt));
        return result.response.text().trim();
    } catch (e) {
        console.error('Document summarization failed:', e);
        return '';
    }
}

export async function getEmbedding(text: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_DOCUMENT", title?: string) {
    // Use v1beta for embedding
    const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const req: any = {
        content: { role: "user", parts: [{ text }] },
        taskType: taskType,
    };
    if (title && taskType === "RETRIEVAL_DOCUMENT") {
        req.title = title;
    }
    const result = await withRetry(() => model.embedContent(req));
    return result.embedding.values;
}

export interface QueryAnalysis {
    needsClarification: boolean;
    clarificationQuestions?: string[];
    searchableQuery: string;
    confidence: 'high' | 'medium' | 'low';
}

export async function analyzeQuery(prompt: string, history: { role: string, content: string }[] = []): Promise<QueryAnalysis> {
    const model = genAI.getGenerativeModel({ model: TEXT_MODEL });

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
        const result = await withRetry(() => model.generateContent(analysisPrompt));
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

export async function condenseQuery(history: { role: string, content: string }[], prompt: string) {
    if (history.length === 0) return prompt;

    try {
        const model = genAI.getGenerativeModel({ model: TEXT_MODEL });
        const condensePrompt = `
            Given the following conversation history and a follow-up question, rephrase the follow-up question to be a standalone search query that captures the user's intent, including any necessary context from the history.
            If the follow-up question is already a standalone question or doesn't depend on history, return it as is.
            Return ONLY the rephrased query.

            History:
            ${history.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n')}

            Follow-up Question: ${prompt}

            Standalone Search Query:
        `;

        const result = await withRetry(() => model.generateContent(condensePrompt));
        const text = result.response.text().trim();
        return text || prompt;
    } catch (e) {
        console.error('Condense query failed:', e);
        return prompt;
    }
}

export async function chatStream(prompt: string, context: string, history: { role: string, content: string }[] = []) {
    const hasContext = context && context.trim().length > 0;
    const isKnowledgeContext = hasContext && context.includes('KNOWLEDGE CONTEXT:');

    const systemPrompt = `
        You are Archie, an intelligent knowledge assistant with access to a structured knowledge graph extracted from documents.

        ${hasContext ? `**KNOWLEDGE CONTEXT PROVIDED:**
        ${isKnowledgeContext
            ? `The context below comes from a knowledge graph - structured topics, factual claims, and their relationships - NOT raw documents.

        - **Topics** represent key concepts in the knowledge base
        - **Claims** are atomic factual statements verified from source documents
        - **Relationships** show how topics connect (governs, depends_on, is_part_of, etc.)

        ${context}`
            : `${context}`}`
        : '**NOTE:** No relevant knowledge was found for this query. This could mean the information hasn\'t been indexed yet, or the query needs refinement.'}

        **YOUR APPROACH:**

        1. **Reason with Structure**:
           ${isKnowledgeContext
            ? '- Use topic relationships to understand broader context\n           - Connect multiple topics when the answer requires it\n           - Navigate the graph to find related information'
            : '- Analyze the provided context carefully\n           - Look for connections between different pieces of information'}

        2. **Cite Claims, Not Documents**:
           ${isKnowledgeContext
            ? '- Reference specific claims as evidence (e.g., "According to the claims under Topic X...")\n           - Each claim is a verified fact - treat it as authoritative\n           - When multiple claims exist, synthesize them coherently'
            : '- Always cite sources using [Source Name] format when using information from context'}

        3. **Answer from Context First**:
           - Always answer using the provided knowledge context when relevant topics or claims are present — do not ask for clarification if the knowledge graph returned information
           - Deliver the information you have clearly and completely; only acknowledge gaps when the context is genuinely empty or entirely off-topic
           - Be conversational in tone but prioritise giving answers over requesting more input

        4. **Navigate the Graph**:
           ${isKnowledgeContext
            ? '- If answer requires connecting multiple topics, explain the relationship path\n           - Point out related topics that might be useful to explore\n           - Show how topics govern, depend on, or are part of each other'
            : '- Make connections between different pieces of information\n           - Suggest related areas to explore'}

        5. **Acknowledge Gaps**:
           - If relevant topics exist but claims are missing, say so explicitly
           - Don't make up information not in the knowledge graph
           - Offer to help search differently or explore related topics

        6. **RESPONSE STRUCTURE RULES (MANDATORY — IGNORE AT YOUR OWN RISK)**:

           Every response you generate MUST follow ALL of these formatting rules:

           a) Use ### headers to label each major topic discussed
           b) Separate every paragraph, header, list, and code block with a blank line
           c) Use --- horizontal rules between unrelated sections
           d) Use - bullets for enumerating items, claims, steps -- do NOT string items together with commas
           e) Use **bold** on every key term or concept the first time it appears
           f) Use numbered lists (1, 2, 3) for sequential instructions
           g) Use block quotes with > for warnings, notes, or callouts
           h) Place tables between paragraphs when comparing data side-by-side
           i) Never use $ signs or LaTeX notation -- use the unicode arrow character (right-arrow) instead

           EXAMPLE you must match exactly:

           ### IT-PEP Methodology

           The IT-PEP methodology governs IT project execution.

           - **Scope:** All production systems
           - **Owner:** Enterprise Architecture
           - **Governs:** Release Management, Change Management

           **Related Topics:**

           - IT-PGP depends_on IT-PEP
           - Release Management is_part_of IT-PEP

           > Note: IT-PEP updated in Q1 2025.

           ---

           YOUR OUTPUT MUST FOLLOW THIS STRUCTURE EXACTLY. DO NOT GENERATE PLAIN TEXT PARAGRAPHS WITHOUT HEADERS. DO NOT SKIP BLANK LINES.
        **Remember**: You're working with structured knowledge, not searching documents. Treat topics as entities and claims as facts. Your goal is to synthesize information from the knowledge graph into clear, helpful answers.
    `;

    const model = genAI.getGenerativeModel({
        model: TEXT_MODEL,
        systemInstruction: systemPrompt
    });
    
    const chatSession = model.startChat({
        history: history.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        }))
    });
    
    const result = await withRetry(() => chatSession.sendMessageStream(prompt));
    return result.stream;
}

export async function chat(prompt: string, context: string, history: { role: string, content: string }[] = []) {
    const hasContext = context && context.trim().length > 0;
    const isKnowledgeContext = hasContext && context.includes('KNOWLEDGE CONTEXT:');

    const systemPrompt = `
        You are Archie, an intelligent knowledge assistant with access to a structured knowledge graph extracted from documents.

        ${hasContext ? `**KNOWLEDGE CONTEXT PROVIDED:**
        ${isKnowledgeContext
            ? `The context below comes from a knowledge graph - structured topics, factual claims, and their relationships - NOT raw documents.

        - **Topics** represent key concepts in the knowledge base
        - **Claims** are atomic factual statements verified from source documents
        - **Relationships** show how topics connect (governs, depends_on, is_part_of, etc.)

        ${context}`
            : `${context}`}`
        : '**NOTE:** No relevant knowledge was found for this query. This could mean the information hasn\'t been indexed yet, or the query needs refinement.'}

        **YOUR APPROACH:**

        1. **Reason with Structure**:
           ${isKnowledgeContext
            ? '- Use topic relationships to understand broader context\n           - Connect multiple topics when the answer requires it\n           - Navigate the graph to find related information'
            : '- Analyze the provided context carefully\n           - Look for connections between different pieces of information'}

        2. **Cite Claims, Not Documents**:
           ${isKnowledgeContext
            ? '- Reference specific claims as evidence (e.g., "According to the claims under Topic X...")\n           - Each claim is a verified fact - treat it as authoritative\n           - When multiple claims exist, synthesize them coherently'
            : '- Always cite sources using [Source Name] format when using information from context'}

        3. **Be Conversational & Interactive**:
           - Engage in dialog, don't just dump information
           - Ask clarifying questions when the query is broad or ambiguous
           - If context doesn't fully answer the question, acknowledge it and ask what specific aspect they need

        4. **Navigate the Graph**:
           ${isKnowledgeContext
            ? '- If answer requires connecting multiple topics, explain the relationship path\n           - Point out related topics that might be useful to explore\n           - Show how topics govern, depend on, or are part of each other'
            : '- Make connections between different pieces of information\n           - Suggest related areas to explore'}

        5. **Acknowledge Gaps**:
           - If relevant topics exist but claims are missing, say so explicitly
           - Don't make up information not in the knowledge graph
           - Offer to help search differently or explore related topics

        6. **Format with Rich Markdown -- THIS IS MANDATORY**:
           You MUST format every response with structural markdown. NEVER output a single block of plain text. Every response must contain multiple formatting elements.

           **Mandatory formatting rules:**
           - Every response MUST have blank lines between paragraphs, sections, and list items
           - Use ### or #### headers to organize topics into sections
           - Use **bold** for key terms, concepts, and important values
           - Use bullet lists (dash followed by space) for enumerations, claims, and feature lists
           - Use numbered lists (number followed by period) for sequential steps or procedures
           - Use code blocks (triple backticks with language name) for commands, code, configurations
           - Use inline code (single backticks) for technical terms, filenames, function names
           - Use tables for structured comparisons or parameter lists
           - Use blockquotes (greater-than sign) for important warnings or highlights
           - Use horizontal rules (three dashes) to visually separate distinct sections
           ${isKnowledgeContext
            ? '\n           - Use relationship arrows (arrow character) to show connections between topics'
            : ''}

           **Example of properly formatted response:**

           ### IT-PEP Methodology
           The IT-PEP methodology governs how projects are structured and executed.

           - **Scope:** All production systems must follow IT-PEP
           - **Owner:** Enterprise Architecture team
           - **Governs:** Release Management, Change Management

           **Related Topics:**
           - IT-PGP depends_on IT-PEP
           - Release Management is_part_of IT-PEP

           Note: IT-PEP was updated in Q1 2025 with new compliance requirements.

           Your responses must follow this structure. Section headers, blank lines, bold terms, bullet lists, and clear visual separation are NOT optional.
        **Remember**: You're working with structured knowledge, not searching documents. Treat topics as entities and claims as facts. Your goal is to synthesize information from the knowledge graph into clear, helpful answers.
    `;

    const model = genAI.getGenerativeModel({
        model: TEXT_MODEL,
        systemInstruction: systemPrompt
    });

    const chatSession = model.startChat({
        history: history.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        }))
    });

    const result = await withRetry(() => chatSession.sendMessage(prompt));
    const response = await result.response;
    return response.text();
}

export async function semanticChunk(text: string): Promise<string[]> {
    const model = genAI.getGenerativeModel({ model: CHUNK_MODEL });
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
        const result = await withRetry(() => model.generateContent(prompt));
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

    const model = genAI.getGenerativeModel({ model: RERANK_MODEL });

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
        const result = await withRetry(() => model.generateContent(prompt));
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

    const model = genAI.getGenerativeModel({ model: RERANK_MODEL });
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
        const result = await withRetry(() => model.generateContent(prompt));
        const text = result.response.text();
        return parseJSON(text, { sufficient: true, missingAspects: [], refinedQueries: [] });
    } catch (e) {
        console.error('Context evaluation failed:', e);
        return { sufficient: true, missingAspects: [], refinedQueries: [] };
    }
}

export async function rerank(query: string, documents: { content: string }[]): Promise<number[]> {
    if (documents.length === 0) return [];

    const model = genAI.getGenerativeModel({ model: RERANK_MODEL });

    const prompt = `
        You are an expert reranker. Given a query and a list of document chunks, rank the chunks based on their relevance to the query.
        Return ONLY a JSON array of indices (0-based) in order of relevance, from most relevant to least relevant.
        Do not include any markdown formatting, just the raw JSON array.

        Query: ${query}

        Chunks:
        ${documents.map((doc, i) => `[${i}] ${doc.content}`).join('\n\n')}

        Indices:`;

    try {
        const result = await withRetry(() => model.generateContent(prompt));
        const text = result.response.text();
        return parseJSON<number[]>(text, documents.map((_, i) => i));
    } catch (e) {
        console.error('Reranking failed:', e);
    }

    // Fallback to original order if reranking fails
    return documents.map((_, i) => i);
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

export async function extractKnowledge(text: string, existingTopicNames: string[] = [], documentSummary?: string): Promise<ExtractedKnowledge> {
    const model = genAI.getGenerativeModel({ model: TEXT_MODEL });

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
        Extract the following:

        1. **Topics**: Key concepts, systems, processes, or entities discussed. For each, provide:
           - name: A clear, specific name (avoid overly generic names like "Security" — prefer "Application Security Policy" or "Network Access Control")
           - description: A 1-2 sentence description capturing what this topic covers
           - category: One of: ${ALLOWED_CATEGORIES.join(', ')}

        2. **Knowledge Claims**: Extract meaningful, substantive facts that someone would actually search for. Each claim must:
           - Be SELF-CONTAINED: understandable without the original document
           - Convey ACTIONABLE or IMPORTANT information (not trivial observations)
           - Include SPECIFIC DETAILS: numbers, names, dates, thresholds, tools, roles when present in the text
           - Reference one of the topics you identified

           GOOD claims: "Production deployments require approval from at least two senior engineers", "The data retention policy mandates 7-year retention for financial records", "PostgreSQL 15 is the approved database for all new microservices"
           BAD claims (DO NOT generate): "Security is important", "The system has features", "There are multiple components", "The document describes a process"

           Aim for 3-10 meaningful claims per substantive section. Prioritize QUALITY over QUANTITY — every claim should carry real information value.

        3. **Relationships**: How topics connect. The "type" MUST be one of: ${RELATIONSHIP_VOCABULARY.join(', ')}. Do not invent other relationship types.

        Return ONLY a valid JSON object:
        {
            "topics": [{"name": "...", "description": "...", "category": "..."}],
            "claims": [{"topic": "...", "claim": "..."}],
            "relationships": [{"source": "...", "target": "...", "type": "..."}]
        }

        Do not include any markdown formatting.

        Document chunk:
        ${text}
    `;

    try {
        const result = await withRetry(() => model.generateContent(prompt));
        const responseText = result.response.text();
        return parseJSON<ExtractedKnowledge>(responseText, { topics: [], claims: [], relationships: [] });
    } catch (e) {
        console.error('Knowledge extraction failed:', e);
    }
    return { topics: [], claims: [], relationships: [] };
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

    const model = genAI.getGenerativeModel({ model: TEXT_MODEL });

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

Return ONLY a JSON array:
[{"topicId": <number>, "parentId": <number|null>}, ...]

Include an entry for every new topic. Do not include markdown formatting.
    `;

    try {
        const result = await withRetry(() => model.generateContent(prompt));
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

    const model = genAI.getGenerativeModel({ model: TEXT_MODEL });
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

Return ONLY a JSON array:
[{"topicId": <number>, "parentId": <number|null>}, ...]

Include an entry for EVERY topic in this batch. Do not include markdown formatting.
        `;

        try {
            const result = await withRetry(() => model.generateContent(prompt));
            const responseText = result.response.text();
            const batchResults = parseJSON<{ topicId: number; parentId: number | null }[]>(responseText, []);
            results.push(...batchResults);
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

    const model = genAI.getGenerativeModel({ model: TEXT_MODEL });
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
        const result = await withRetry(() => model.generateContent(prompt));
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

    const model = genAI.getGenerativeModel({ model: TEXT_MODEL });
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
        const result = await withRetry(() => model.generateContent(prompt));
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

function parseJSON<T>(text: string, fallback: T): T {
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
                // For now, just log and fallback.
                console.error('JSON parse error after extraction:', e, 'JSON string:', jsonStr.substring(0, 100) + '...');
            }
        } else {
            // Try parsing the whole thing as a last resort
            return JSON.parse(cleaned);
        }
    } catch (e) {
        console.error('Failed to parse JSON from LLM response:', e, 'Raw text:', text.substring(0, 100) + '...');
    }
    return fallback;
}
