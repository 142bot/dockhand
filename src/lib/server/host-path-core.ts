/**
 * Pure host-path helpers. NO db / docker import, so unit-testable directly
 * (importing host-path.ts pulls in the DB layer and would boot the database).
 */

/**
 * Whether an environment can be used to inspect Dockhand's OWN container over a
 * plain tcp:// address (the socket-proxy fallback, #1203/#1204). Only plain-http
 * `direct` envs qualify: socket envs give no host:port (and we have no socket to
 * reach anyway), https/mTLS envs need certs a bare tcp:// would drop, hawser envs
 * are remote agents.
 */
export function isSelfInspectCandidate(env: {
	connectionType?: string | null;
	protocol?: string | null;
	host?: string | null;
	port?: number | null;
}): boolean {
	return env.connectionType === 'direct'
		&& (env.protocol ?? 'http') === 'http'
		&& !!env.host && !!env.port;
}
