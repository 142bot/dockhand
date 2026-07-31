/**
 * Pangolin label → public URL extraction (#2 follow-up).
 *
 * Pangolin Blueprints (https://docs.pangolin.net/manage/blueprints) annotates
 * a container with one or more resources, scoped public OR private. The
 * relevant labels for URL extraction are:
 *
 *   pangolin.public-resources.<name>.name          human-friendly label
 *   pangolin.public-resources.<name>.full-domain   public hostname (mandatory)
 *   pangolin.public-resources.<name>.ssl           true | false — picks https|http
 *   pangolin.private-resources.<name>.{name,full-domain,ssl}   private equivalents
 *
 * SCHEME comes from `ssl` ONLY (verified against Pangolin's source):
 *   - ssl=true  -> https,  ssl=false -> http
 *   - ssl absent -> scope default: PUBLIC = https (Pangolin forces ssl=true when
 *     unset), PRIVATE = http (the ssl DB column defaults to false).
 * The `protocol`/`mode` label is the resource TYPE (http/tcp/udp/...), NOT the URL
 * scheme (Pangolin doesn't accept `protocol=https`), so it is deliberately ignored.
 *
 * Both scopes resolve to a URL the user can click. The scope (`public`/
 * `private`) is preserved on the result so callers can label or filter.
 *
 * The `targets[N].port` family is intentionally ignored — Pangolin terminates
 * the connection at full-domain; the internal target port is not part of the
 * URL a user sees.
 *
 * Returns one URL per resource that declares a full-domain. Multiple
 * resources on the same container yield multiple URLs. Identical URLs across
 * different resources are deduped.
 *
 * dockhand.url labels override this — Pangolin extraction is a fallback,
 * never a winner over an explicit user-provided URL.
 *
 * Earlier v1.0.34 used `pangolin.proxy-resources.*` — that label was never
 * recognised by Pangolin itself and is no longer accepted here.
 */
export interface PangolinUrl {
	url: string;
	/** The Pangolin resource key (the `<name>` in the label key). */
	resource: string;
	/** Scope from the label namespace — public or private. */
	scope: 'public' | 'private';
	/** Optional human-friendly name from the `.name` label, if set. */
	displayName?: string;
}

// The URL scheme is decided by the `ssl` label ONLY. `protocol`/`mode` is the
// resource TYPE (http/tcp/udp/...), never the scheme — Pangolin doesn't even accept
// `protocol=https`. We still capture `name` for the display label; `full-domain` is
// mandatory for a URL to exist.
const RESOURCE_KEY_RE =
	/^pangolin\.(public|private)-resources\.([^.]+)\.(full-domain|ssl|name)$/;

/** Parse a Pangolin boolean label ("true"/"false", case-insensitive). Anything
 *  else (incl. absent) yields undefined so the scope default applies. */
function parseSsl(v: string): boolean | undefined {
	const s = v.toLowerCase();
	if (s === 'true') return true;
	if (s === 'false') return false;
	return undefined;
}

export function extractPangolinUrls(
	labels: Record<string, string> | undefined | null
): PangolinUrl[] {
	if (!labels) return [];

	// Group label values by (scope, resource) key. A single resource name can
	// legitimately appear under both scopes (rare but allowed by Pangolin);
	// they're treated as independent resources here.
	const byResource = new Map<
		string,
		{ scope: 'public' | 'private'; resource: string; fullDomain?: string; ssl?: boolean; name?: string }
	>();

	for (const [key, value] of Object.entries(labels)) {
		const m = key.match(RESOURCE_KEY_RE);
		if (!m) continue;
		const [, scope, resource, field] = m as unknown as [string, 'public' | 'private', string, string];
		const groupKey = `${scope}:${resource}`;
		let entry = byResource.get(groupKey);
		if (!entry) {
			entry = { scope, resource };
			byResource.set(groupKey, entry);
		}
		const v = (value ?? '').trim();
		if (!v) continue;
		if (field === 'full-domain') entry.fullDomain = v;
		else if (field === 'ssl') entry.ssl = parseSsl(v);
		else if (field === 'name') entry.name = v;
	}

	const out: PangolinUrl[] = [];
	const seen = new Set<string>();

	for (const entry of byResource.values()) {
		if (!entry.fullDomain) continue;

		// Scheme resolution mirrors Pangolin's source exactly:
		//   ssl present  -> ssl ? https : http
		//   ssl absent   -> scope default: public = https (code forces true),
		//                    private = http (DB column default false).
		const ssl = entry.ssl ?? (entry.scope === 'public');
		const proto = ssl ? 'https' : 'http';

		const url = `${proto}://${entry.fullDomain}`;
		if (seen.has(url)) continue;
		seen.add(url);

		out.push({
			url,
			resource: entry.resource,
			scope: entry.scope,
			displayName: entry.name
		});
	}

	return out;
}
