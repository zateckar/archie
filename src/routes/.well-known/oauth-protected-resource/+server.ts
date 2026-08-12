import { protectedResourceMetadataResponse } from '$lib/server/oauth-metadata';
import type { RequestHandler } from './$types';

/**
 * RFC 9728 protected-resource metadata, at the bare well-known path.
 *
 * The fallback location: clients try `/.well-known/oauth-protected-resource/api/mcp`
 * first (see the sibling route) and come here when that 404s. Public — see
 * PUBLIC_ROUTES in hooks.server.ts for why it has to be.
 */
export const GET: RequestHandler = async ({ url }) => protectedResourceMetadataResponse(url.origin);
