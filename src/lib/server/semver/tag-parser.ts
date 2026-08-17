/**
 * Parse a Docker image tag into its numeric version and the text around it, so
 * two tags of the SAME image can be compared as versions.
 *
 * A tag is `<prefix><version><suffix>` where version is the first dotted-number
 * run: `v1.25-alpine` -> prefix `v`, version `1.25`, suffix `-alpine`. The
 * version becomes a plain numeric tuple (`[1, 25]`), which compares CalVer
 * (`2024.1.3`) and SemVer (`1.2.3`) alike with no semver library and no special
 * cases. Pure functions, no I/O.
 */

/** The first dotted-number run in a tag: 2 to 4 numeric segments. */
const VERSION_RE = /\d+\.\d+(?:\.\d+)?(?:\.\d+)?/;

export interface ParsedTag {
	/** The matched version text, e.g. `1.25` or `2024.1.3`. */
	version: string;
	/** Text before the version, e.g. `v` in `v1.25`. */
	prefix: string;
	/** Text after the version, e.g. `-alpine` in `1.25-alpine`. This is the "flavor". */
	suffix: string;
	/** The version as a numeric tuple, e.g. `[1, 25]`. */
	parts: number[];
}

/** Parse a tag into its version parts, or null when it has no version (`latest`, `stable`, a sha). */
export function parseTag(tag: string): ParsedTag | null {
	const match = VERSION_RE.exec(tag);
	if (!match) return null;

	const version = match[0];
	return {
		version,
		prefix: tag.slice(0, match.index),
		suffix: tag.slice(match.index + version.length),
		parts: version.split('.').map(Number)
	};
}

/**
 * Two prefixes are equivalent, treating `""` and `"v"` as the same — projects
 * routinely add or drop the leading `v` between releases (`1.2.3` vs `v1.2.3`).
 */
export function prefixMatches(a: string, b: string): boolean {
	const normalize = (p: string) => (p === 'v' ? '' : p);
	return normalize(a) === normalize(b);
}

// A channel marker delimited by start/`-`/`.`, optionally followed by a number
// (`rc1`, `beta.2`) or another delimiter. `\b` won't do: `rc1` has no boundary
// between `c` and `1`.
const PRERELEASE_RE = /(^|[-.])(rc|beta|alpha|nightly|dev|pre|snapshot)(\d|[-.]|$)/i;

// A trailing commit hash, e.g. `-b2da6b90f` in searxng's `2026.8.16-b2da6b90f`.
// Requiring 7+ pure-hex chars keeps real build variants (`-alpine`, `-ls123`,
// `-ubuntu22.04`) intact - they aren't long hex runs - while collapsing the
// per-release hash so every hashed tag of one image shares a flavor and can be
// compared. Guarded by at least one letter so a plain numeric build (`-12345678`)
// isn't mistaken for a hash.
const COMMIT_HASH_RE = /[-.](?=[0-9a-f]*[a-f])[0-9a-f]{7,}$/i;

export function isPrerelease(tag: ParsedTag): boolean {
	return PRERELEASE_RE.test(tag.suffix);
}

/**
 * The "flavor" is the stable part of the suffix — the build variant like
 * `-alpine` or `-ls123` — with any prerelease channel and any trailing commit
 * hash stripped off. So `1.0-alpine` and `1.1-alpine` share the flavor `-alpine`,
 * `1.0-rc1` / `1.0-rc2` share the flavor `` (they only differ in the prerelease),
 * and `2026.8.15-a1b2c3d` / `2026.8.16-b2da6b9` share the flavor `` (they only
 * differ in the per-release hash). This lets one hashed tag suggest the next
 * while still never mixing `-alpine` with bare.
 */
export function flavorOf(tag: ParsedTag): string {
	return tag.suffix
		.replace(COMMIT_HASH_RE, '')
		.replace(PRERELEASE_RE, (_m, delim: string) => (delim === '.' ? '' : delim))
		.replace(/[-.]+$/, ''); // drop the delimiter the prerelease left dangling
}

/** A newer version is only offered within the SAME flavor. Exact match, prerelease-agnostic. */
export function flavorMatches(a: ParsedTag, b: ParsedTag): boolean {
	return flavorOf(a) === flavorOf(b);
}

/** Compare two version tuples pairwise (missing segments count as 0). <0, 0, or >0. */
export function compareParts(a: ParsedTag, b: ParsedTag): number {
	const length = Math.max(a.parts.length, b.parts.length);
	for (let i = 0; i < length; i++) {
		const diff = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
