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

        6. **Format for Clarity**:
           ${isKnowledgeContext
            ? '- Organize by topics when helpful\n           - Use markdown headers (###), bullets, and bold text\n           - Show relationships visually (e.g., "Topic A → depends_on → Topic B")\n           - Keep explanations concise (2-3 sentences per claim)'
            : '- Use Markdown headers (###), bold, bullets, and code blocks\n           - Structure responses with clear sections\n           - Keep paragraphs concise (2-3 sentences max)'}

        **Example Response Structure** (when working with knowledge graph):

        ### [Topic Name]
        - Claim 1
        - Claim 2

        **Related Topics:**
        - Topic A (depends_on) - relevant claims here
        - Topic B (governs) - relevant claims here

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

        6. **Format for Clarity**:
           ${isKnowledgeContext
            ? '- Organize by topics when helpful\n           - Use markdown headers (###), bullets, and bold text\n           - Show relationships visually (e.g., "Topic A → depends_on → Topic B")\n           - Keep explanations concise (2-3 sentences per claim)'
            : '- Use Markdown headers (###), bold, bullets, and code blocks\n           - Structure responses with clear sections\n           - Keep paragraphs concise (2-3 sentences max)'}

        **Example Response Structure** (when working with knowledge graph):

        ### [Topic Name]
        - Claim 1
        - Claim 2

        **Related Topics:**
        - Topic A (depends_on) - relevant claims here
        - Topic B (governs) - relevant claims here

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

export async function extractKnowledge(text: string, existingTopicNames: string[] = []): Promise<ExtractedKnowledge> {
    const model = genAI.getGenerativeModel({ model: TEXT_MODEL });

    const vocabularyHint = existingTopicNames.length > 0
        ? `
        EXISTING CANONICAL TOPICS (reuse these names verbatim whenever the same concept appears in the document; only invent a new topic if the concept is genuinely not in this list):
        ${existingTopicNames.map((n) => `- ${n}`).join('\n        ')}
        `
        : '';

    const prompt = `
        You are an expert knowledge engineer. Your task is to extract ALL relevant structured information from the following IT-related document snippet.

        1. **Topics**: Identify every topic discussed. For each topic, provide a name, a brief description, and a category. Category MUST be one of: ${ALLOWED_CATEGORIES.join(', ')}.
        2. **Knowledge Claims**: Extract EVERY atomic, verifiable fact, rule, responsibility, deadline, threshold, tool reference, role assignment, allowed/forbidden action, document reference, retention period, or numeric requirement. Be exhaustive — aim for 5-15 claims per substantive paragraph. Each claim must reference one of the topics you identified.
        3. **Relationships**: Identify how the topics relate. The "type" MUST be one of: ${RELATIONSHIP_VOCABULARY.join(', ')}. Do not invent other relationship types.
        ${vocabularyHint}

        Return ONLY a valid JSON object with the following structure:
        {
            "topics": [{"name": "...", "description": "...", "category": "..."}],
            "claims": [{"topic": "...", "claim": "..."}],
            "relationships": [{"source": "...", "target": "...", "type": "..."}]
        }

        Do not include any markdown formatting.

        Document:
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
