/**
 * URL-safety primitives shared across subsystems (backup destinations,
 * notification channels, and anything else that fetches a user-configured URL).
 *
 * Neutral home: these functions have no dependency on the backup engine or the
 * notification router — both import DOWN into here rather than sideways into
 * each other. Pure functions, safe to unit-test in isolation.
 */

/**
 * SSRF guard for user-configured webhook URLs. Rejects non-http(s) schemes and
 * hosts that are loopback / private / link-local / metadata IPs. Returns { ok }
 * or { ok:false, reason }. NOTE: this checks the LITERAL host in the URL; a
 * hostname that resolves to a private IP via DNS is not caught here — full
 * DNS-rebinding protection (resolve + re-check at fetch time) is a follow-up.
 */
export function isSafeWebhookUrl(raw: string): { ok: boolean; reason?: string } {
	let u: URL;
	try { u = new URL(raw); } catch { return { ok: false, reason: 'not a valid URL' }; }
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		return { ok: false, reason: `scheme ${u.protocol} not allowed (use http/https)` };
	}
	const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
	if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'localhost blocked' };
	const ipReason = privateIpReason(host);
	if (ipReason) return { ok: false, reason: ipReason };
	return { ok: true };
}

/**
 * SSRF guard for user-configured NOTIFICATION endpoints. Deliberately more
 * permissive than isSafeWebhookUrl: it blocks only loopback and cloud-metadata
 * (169.254.169.254) hosts — the addresses with no legitimate notification use
 * and the highest SSRF value — while allowing ordinary LAN ranges (10.x,
 * 192.168.x, 172.16-31.x) so a self-hosted ntfy/gotify/webhook receiver on the
 * local network still works. Same literal-host caveat as isSafeWebhookUrl.
 */
export function isSafeNotificationUrl(raw: string): { ok: boolean; reason?: string } {
	let u: URL;
	try { u = new URL(raw); } catch { return { ok: false, reason: 'not a valid URL' }; }
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		return { ok: false, reason: `scheme ${u.protocol} not allowed (use http/https)` };
	}
	const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'localhost blocked' };
	const reason = dangerousHostReason(host);
	if (reason) return { ok: false, reason };
	return { ok: true };
}

/**
 * Classify an IP-literal host into a range category, or null if it is not an IP
 * literal or is an ordinary public address. Splitting loopback/metadata from the
 * broader private ranges lets callers choose their own policy: backup
 * destinations block everything private; notifications block only the dangerous
 * subset (loopback + cloud metadata) so a LAN endpoint on 10.x/192.168.x still
 * works. Non-IP hostnames return null (not literals to judge here).
 */
export type IpCategory = 'loopback' | 'metadata' | 'private' | 'reserved';

/**
 * Extract the embedded IPv4 dotted-quad from an IPv4-mapped/compatible IPv6 host,
 * or null. `new URL()` normalizes `::ffff:1.2.3.4` to the HEX form `::ffff:102:304`,
 * so a regex on the dotted form alone is dead on the real code path — every mapped
 * address must be canonicalized from its hextets. Handles the compressed
 * `::ffff:HHHH:HHHH`, the fully-expanded `0:0:0:0:0:ffff:HHHH:HHHH`, the
 * `::ffff:0:HHHH:HHHH` (v4-translated), and the deprecated IPv4-compatible
 * `::HHHH:HHHH` / `::a.b.c.d`. The last two 16-bit hextets carry the 32-bit v4.
 */
function embeddedV4(h: string): string | null {
	// Trailing dotted quad after a v4-mapped/compatible prefix, in either the
	// compressed (::ffff:1.2.3.4) or fully-expanded (0:0:0:0:0:ffff:1.2.3.4) form.
	const dotted = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	if (dotted && /^(::ffff:|::ffff:0:|::|(0:){5}ffff:|(0:){4}0:ffff:)/.test(h)) {
		return dotted[1];
	}
	// Hex-hextet v4-mapped/compatible forms. Take the last two colon-separated
	// groups as the 32-bit v4 IFF the address is one of the embedded-v4 shapes.
	const isMapped =
		/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h) ||
		/^::ffff:0:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h) ||
		/^(0:){5}ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h) ||
		/^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h); // deprecated v4-compatible ::a:b
	if (!isMapped) return null;
	const groups = h.split(':').filter((g) => g.length > 0);
	if (groups.length < 2) return null;
	const hi = parseInt(groups[groups.length - 2], 16);
	const lo = parseInt(groups[groups.length - 1], 16);
	if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
	return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function ipCategory(host: string): IpCategory | null {
	const h = host.toLowerCase().replace(/^\[|\]$/g, '');
	// IPv6 loopback / unspecified, then link-local / unique-local (private).
	if (h === '::1') return 'loopback';
	if (h === '::' || h === '::0') return 'reserved'; // unspecified / all-interfaces
	// Require a colon so real IPv6 unique-local/link-local literals match but public
	// DNS names starting "fc"/"fd" (fcm.googleapis.com, fdroid.link) do not.
	if (h.startsWith('fe80:') || /^f[cd][0-9a-f]{0,2}:/.test(h)) return 'private';
	// IPv4-mapped/compatible IPv6 — judge the embedded v4 (see embeddedV4).
	const v4 = embeddedV4(h) ?? h;
	const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) {
		const [a, b] = [Number(m[1]), Number(m[2])];
		if (a === 127 || a === 0) return 'loopback';
		if (a === 169 && b === 254) return 'metadata'; // link-local / cloud metadata
		if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return 'private';
		if (a >= 224) return 'reserved'; // multicast/reserved
	}
	return null;
}

/**
 * The shared SSRF policy for user-configured hosts that legitimately live on a
 * LAN in self-hosted deployments (backup repos, notification receivers): block
 * only the addresses with no legitimate use and the highest SSRF value —
 * loopback, cloud metadata (169.254.169.254), and multicast/reserved — while
 * ALLOWING ordinary private ranges (10.x / 192.168.x / 172.16-31.x). Returns a
 * reason string for a blocked literal-IP host, or null. Non-IP hosts return null.
 */
export function dangerousHostReason(host: string): string | null {
	const cat = ipCategory(host);
	if (cat === 'loopback' || cat === 'metadata' || cat === 'reserved') {
		return `${cat} address (${host}) blocked`;
	}
	return null;
}

/**
 * Given a host string that IS an IP literal (v4 or v6), return a reason string
 * if it falls in ANY loopback / private / link-local / metadata / reserved
 * range, else null. This is the STRICT policy (block all private) used by backup
 * destinations. Non-IP hostnames return null.
 */
export function privateIpReason(host: string): string | null {
	const cat = ipCategory(host);
	if (!cat) return null;
	return `private/loopback IP (${host}) blocked`;
}
