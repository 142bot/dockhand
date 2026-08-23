import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSelfhstIcon, isValidSelfhstRef } from '$lib/server/selfhst-icons';

/**
 * @openapi
 * summary: Get a selfh.st app icon (raw SVG), fetched once from the CDN and cached on disk
 * description: Proxies an icon from the selfh.st collection so the browser never contacts an external CDN directly. The first request for a given ref fetches the SVG from jsdelivr and caches it under DATA_DIR; later requests are served locally. Icons are CC BY 4.0 (selfh.st). Returns 404 if the ref is invalid or the icon can't be fetched, so the UI falls back to a generic icon.
 * path: ref:string! selfh.st icon Reference (lowercase letters, digits, hyphens), e.g. "plex"
 * resp-200: Raw image/svg+xml body, Cache-Control public max-age=604800
 * resp-400: The ref is not a valid selfh.st reference
 * resp-404: No such icon (invalid ref or upstream fetch failed)
 */
export const GET: RequestHandler = async ({ params }) => {
	const ref = params.ref;
	if (!isValidSelfhstRef(ref)) {
		return json({ error: 'Invalid icon reference' }, { status: 400 });
	}
	const buf = await getSelfhstIcon(ref);
	if (!buf) {
		return json({ error: 'Icon not found' }, { status: 404 });
	}
	return new Response(new Uint8Array(buf), {
		headers: {
			'Content-Type': 'image/svg+xml',
			'Cache-Control': 'public, max-age=604800',
			// The SVG is sanitized at cache time; these headers are belt-and-braces so
			// even a direct navigation to this URL cannot execute embedded content.
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			'X-Content-Type-Options': 'nosniff'
		}
	});
};
