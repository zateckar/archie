import { protectedResourceMetadataResponse } from '$lib/server/oauth-metadata';
import type { RequestHandler } from './$types';

/**
 * RFC 9728 protected-resource metadata for the resource `<origin>/api/mcp`.
 *
 * The well-known segment is inserted between host and path, so the document for a
 * resource at `/api/mcp` lives here. This is the URL the 401 challenge advertises
 * in its `resource_metadata` parameter, and the one MCP clients try first.
 */
export const GET: RequestHandler = async ({ url }) => protectedResourceMetadataResponse(url.origin);
