/**
 * Fetch per-version release notes from GitHub for the versions a semver check
 * surfaced. The match core (release-tag <-> wanted-version) is pure and unit-
 * tested; only the fetch touches the network. Degrades to an empty list on any
 * failure, so the modal always renders (it falls back to a plain link).
 */

import { parseTag, compareParts } from './tag-parser';
import type { ReleaseSource } from './release-source';
import { isSafeNotificationUrl } from '../url-safety';

export interface ReleaseNote {
	/** The requested version tag this note is for, e.g. `16.4-alpine`. */
	version: string;
	/** The GitHub release name/title (may be empty). */
	name: string;
	/** The GitHub release tag, e.g. `v16.4`. */
	githubTag: string;
	/** Markdown body of the release. */
	body: string;
	/** ISO date the release was published. */
	publishedAt: string | null;
	/** Direct link to the release page. */
	url: string;
}

interface GithubRelease {
	tag_name: string;
	name: string | null;
	body: string | null;
	published_at: string | null;
	html_url: string;
	draft: boolean;
	prerelease: boolean;
}

/**
 * Pick, for each wanted version tag, the GitHub release whose tag parses to the
 * SAME numeric version. Pure: `releases` is whatever the API returned, `wanted`
 * is the list of image tags (target + skipped). Flavor/prefix noise is ignored —
 * only the numeric tuple has to match, so `v16.4` matches `16.4-alpine`.
 */
export function matchReleasesToVersions(
	releases: Pick<GithubRelease, 'tag_name' | 'name' | 'body' | 'published_at' | 'html_url'>[],
	wanted: string[]
): ReleaseNote[] {
	const notes: ReleaseNote[] = [];
	for (const version of wanted) {
		const parsedWanted = parseTag(version);
		if (!parsedWanted) continue;
		const match = releases.find((r) => {
			const parsedRelease = parseTag(r.tag_name);
			return parsedRelease && compareParts(parsedRelease, parsedWanted) === 0;
		});
		if (match) {
			notes.push({
				version,
				name: match.name ?? '',
				githubTag: match.tag_name,
				body: match.body ?? '',
				publishedAt: match.published_at,
				url: match.html_url
			});
		}
	}
	return notes;
}

const PER_PAGE = 100;
const MAX_PAGES = 3; // 300 recent releases is plenty to cover a handful of skipped versions.

/**
 * Fetch release notes for `wanted` versions from a GitHub or Gitea/Forgejo forge.
 * Both APIs return the same fields and page newest-first; only the page-size
 * query param differs (`per_page` vs `limit`). Walks pages until every wanted
 * version is matched or the page budget is spent. Never throws.
 */
export interface ReleaseNotesResult {
	notes: ReleaseNote[];
	/** True when GitHub refused the request because the (usually unauthenticated)
	 *  rate limit is exhausted - the UI can then suggest setting a token. Only ever
	 *  set for the github.com source; a self-hosted forge doesn't have this limit. */
	rateLimited: boolean;
}

/** True for a GitHub response that means "you're rate limited": a 403/429 whose
 *  X-RateLimit-Remaining header is 0 (the primary-limit signal). */
function isRateLimited(res: { status: number; headers: { get(name: string): string | null } }): boolean {
	if (res.status !== 403 && res.status !== 429) return false;
	const remaining = res.headers.get('x-ratelimit-remaining');
	// If the header is present it must be 0; if absent (429 without it), treat as limited.
	return remaining === null || remaining.trim() === '0';
}

export async function fetchReleaseNotes(
	src: ReleaseSource,
	wanted: string[],
	fetchImpl: typeof fetch = fetch
): Promise<ReleaseNotesResult> {
	if (wanted.length === 0) return { notes: [], rateLimited: false };

	// SSRF guard: for a Gitea/Forgejo forge, apiBase's host comes from the
	// container's org.opencontainers.image.source LABEL (user-controllable), so a
	// crafted label could point the fetch at loopback/metadata. Block those but
	// allow LAN forges (a self-hosted Gitea legitimately lives on 192.168.x). The
	// github.com branch is hardcoded to api.github.com and needs no guard.
	if (src.kind !== 'github') {
		const safety = isSafeNotificationUrl(src.apiBase);
		if (!safety.ok) return { notes: [], rateLimited: false };
	}

	const pageSizeParam = src.kind === 'github' ? 'per_page' : 'limit';
	// Unauthenticated GitHub is 60 req/h per IP; a token raises it to 5000/h. Optional -
	// only sent to github.com, so a self-hoster who sets it gets far more headroom (and CI
	// stops rate-limiting). Never sent to a Gitea/Forgejo forge (different auth).
	const ghToken =
		src.kind === 'github'
			? (process.env.DOCKHAND_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim()
			: '';
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'User-Agent': 'dockhand'
	};
	if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

	const collected: GithubRelease[] = [];
	// Only flag rate limiting for github.com with no token configured - that's the
	// case a token would actually fix.
	const canBeRateLimited = src.kind === 'github' && !ghToken;
	let rateLimited = false;
	try {
		for (let page = 1; page <= MAX_PAGES; page++) {
			const url = `${src.apiBase}?${pageSizeParam}=${PER_PAGE}&page=${page}`;
			const res = await fetchImpl(url, { headers, redirect: 'manual' });
			if (res.status >= 300 && res.status < 400) break; // refuse to follow a redirect to a possibly-private host
			if (!res.ok) {
				if (canBeRateLimited && isRateLimited(res)) rateLimited = true;
				break;
			}
			const batch = (await res.json()) as GithubRelease[];
			if (!Array.isArray(batch) || batch.length === 0) break;
			collected.push(...batch.filter((r) => !r.draft));

			// Stop early once we can match everything we're after.
			const matched = matchReleasesToVersions(collected, wanted);
			if (matched.length >= wanted.length) break;
			if (batch.length < PER_PAGE) break;
		}
	} catch {
		return { notes: matchReleasesToVersions(collected, wanted), rateLimited };
	}

	return { notes: matchReleasesToVersions(collected, wanted), rateLimited };
}
