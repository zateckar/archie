import { json } from '@sveltejs/kit';
import { knowledgeStats } from '$lib/server/knowledge-queries';
import type { RequestHandler } from './$types';

/**
 * Headline counts for the knowledge explorer and the admin dashboard.
 *
 * These used to be derived in the browser from the full-corpus payload (four
 * passes over every claim), which meant the page could not show a single number
 * without downloading everything first.
 */
export const GET: RequestHandler = async () => {
    return json(knowledgeStats());
};
