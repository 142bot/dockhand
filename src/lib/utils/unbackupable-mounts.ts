/**
 * Bind mounts that must never be backed up: Docker/containerd sockets and host
 * system paths that are infrastructure, not data. Backing up a socket is
 * meaningless (it's a device node, not files) and a "backup all" that captures
 * /proc or /var/run is pointless and slow.
 *
 * Dependency-free so BOTH the backup engine (discovery-core.ts, which enumerates
 * mounts itself for "backup all") and the UI picker (utils/mounts.ts) can share
 * the exact same rule with no drift.
 *
 * Matches on the HOST SOURCE path of a bind mount, not the container destination
 * (the source is what identifies "this is the host's docker socket", regardless
 * of where a container maps it).
 */

/** Exact host source paths (or their children) that are never backed up. */
const UNBACKUPABLE_PREFIXES = [
	'/proc',
	'/sys',
	'/dev',
	'/var/run',
	'/run',
];

/** Exact socket files, matched anywhere, in case they live outside the prefixes
 *  above (e.g. rootless docker under /var/run/user/<uid>, already covered by
 *  /var/run, but a socket bound from an unusual path still gets caught here). */
const UNBACKUPABLE_SOCKET_BASENAMES = ['docker.sock', 'containerd.sock'];

/** True if a bind mount's host SOURCE is infrastructure that must not be backed
 *  up (a socket or a host system path). Only applies to bind mounts — named
 *  volumes are always data. */
export function isUnbackupableBindSource(hostSource: string | undefined | null): boolean {
	if (!hostSource || !hostSource.startsWith('/')) return false;
	const path = hostSource.replace(/\/+$/, ''); // drop trailing slash
	const base = path.slice(path.lastIndexOf('/') + 1);
	if (UNBACKUPABLE_SOCKET_BASENAMES.includes(base)) return true;
	for (const prefix of UNBACKUPABLE_PREFIXES) {
		if (path === prefix || path.startsWith(prefix + '/')) return true;
	}
	return false;
}
