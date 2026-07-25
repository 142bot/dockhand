/**
 * Canonical volume/bind normalization for the backup UI.
 *
 * Three surfaces (CreateBackupModal, BackupPanel via EditContainerModal, and
 * EnvironmentBackupsTab) previously each open-coded "Docker mounts -> pickable
 * volume list" and drifted: one dropped bind mounts entirely, one never set a
 * mount type (so every row rendered as a named volume). Both symptoms trace to
 * duplicated logic. This module is the single source of truth.
 *
 * Kept dependency-free (no Svelte/lucide/db imports) so it is unit-testable
 * under `bun test`.
 */

export interface VolumeInfo {
	name: string;
	mountPoint: string;
	mountType: 'volume' | 'bind';
}

/** A raw Docker mount as returned by the containers API (list or inspect).
 *  Both lowercase (our normalized) and PascalCase (raw Docker) keys are
 *  tolerated because callers pass either shape. */
interface RawMount {
	type?: string;
	Type?: string;
	name?: string;
	Name?: string;
	source?: string;
	Source?: string;
	destination?: string;
	Destination?: string;
}

/** Docker's Binds are `hostPath:containerPath[:mode]`; a named volume's
 *  "hostPath" is the volume NAME (no leading slash), a bind mount's is an
 *  absolute host path. This is the standard heuristic Docker itself uses. */
export function mountTypeFromHostPath(hostPath: string): 'volume' | 'bind' {
	return hostPath.startsWith('/') ? 'bind' : 'volume';
}

/**
 * Normalize a container's raw Docker mounts into the pickable volume list.
 * Keeps only `volume` and `bind` mounts (skips tmpfs/npipe/etc.), and derives
 * a stable display `name` (volume name, else source, else destination).
 */
export function normalizeMounts(mounts: RawMount[] | null | undefined): VolumeInfo[] {
	if (!Array.isArray(mounts)) return [];
	const out: VolumeInfo[] = [];
	for (const m of mounts) {
		const type = m.type || m.Type;
		if (type !== 'volume' && type !== 'bind') continue;
		const name = m.name || m.Name || m.source || m.Source || m.destination || m.Destination || '';
		out.push({
			name,
			mountPoint: m.destination || m.Destination || '',
			mountType: type === 'bind' ? 'bind' : 'volume'
		});
	}
	return out;
}

/**
 * Merge the mounts of every container in a compose project into one deduped
 * volume list (by display name). Used for stack-level backup pickers.
 */
export function normalizeStackMounts(
	containers: Array<{ mounts?: RawMount[]; Mounts?: RawMount[] }>
): VolumeInfo[] {
	const seen = new Set<string>();
	const out: VolumeInfo[] = [];
	for (const c of containers) {
		for (const v of normalizeMounts(c.mounts || c.Mounts)) {
			if (v.name && !seen.has(v.name)) {
				seen.add(v.name);
				out.push(v);
			}
		}
	}
	return out;
}

/** The compose-project label that groups containers into a stack. */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/** A raw container as returned by the /api/containers list endpoint. Tolerates
 *  the Docker-raw fallback keys (`Mounts`, `Names`) the same way the mount
 *  normalizers do, so callers can pass either shape. */
export interface RawContainer {
	name?: string;
	Names?: string[];
	labels?: Record<string, string | undefined>;
	Labels?: Record<string, string | undefined>;
	mounts?: RawMount[];
	Mounts?: RawMount[];
}

/** A pickable backup target: a stack (mounts of all its containers, merged) or
 *  a standalone container. */
export interface BackupItem {
	name: string;
	type: 'stack' | 'container';
	volumes: VolumeInfo[];
}

function containerName(c: RawContainer): string {
	return c.name || c.Names?.[0]?.replace(/^\//, '') || '';
}

function composeProject(c: RawContainer): string | undefined {
	const labels = c.labels || c.Labels;
	return labels?.[COMPOSE_PROJECT_LABEL];
}

/**
 * Partition a raw /api/containers list into stack items (grouped by the compose
 * project label, mounts merged+deduped across the stack's containers) and
 * standalone container items. Sorted: stacks first, then containers, each
 * alphabetical.
 *
 * NOTE: deriving stacks from container labels can't see a stack's sourceType and
 * misses stopped stacks (no live containers). Backup-discovery surfaces now take
 * stacks from /api/stacks and standalone containers from {@link standaloneContainers}.
 * This whole-list grouping is kept for any caller that only has a container list.
 */
export function groupContainersForBackup(containers: RawContainer[] | null | undefined): BackupItem[] {
	if (!Array.isArray(containers)) return [];
	const stackContainers = new Map<string, RawContainer[]>();
	const standalone: BackupItem[] = [];
	for (const c of containers) {
		const project = composeProject(c);
		if (project) {
			const existing = stackContainers.get(project) || [];
			existing.push(c);
			stackContainers.set(project, existing);
		} else {
			standalone.push({ name: containerName(c), type: 'container', volumes: normalizeMounts(c.mounts || c.Mounts) });
		}
	}
	return [
		...[...stackContainers.entries()].map(([name, cs]): BackupItem => ({
			name,
			type: 'stack',
			volumes: normalizeStackMounts(cs)
		})),
		...standalone
	].sort((a, b) => {
		if (a.type !== b.type) return a.type === 'stack' ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

/**
 * Volumes for ONE stack: the stack slice of {@link groupContainersForBackup}.
 * Returns [] if the stack has no containers (stopped / not-yet-deployed) — that
 * is now the ONLY path that can legitimately produce an empty picker.
 */
export function volumesForStack(
	containers: RawContainer[] | null | undefined,
	stackName: string
): VolumeInfo[] {
	if (!Array.isArray(containers)) return [];
	const mine = containers.filter((c) => composeProject(c) === stackName);
	return normalizeStackMounts(mine);
}

/**
 * The STANDALONE-container slice of a /api/containers list: every container
 * WITHOUT a compose-project label, as a backup item with its mounts normalized.
 * Sorted alphabetically.
 *
 * This exists because the stack slice of a backup list must now come from
 * /api/stacks (the single source that knows a stack's sourceType and includes
 * stopped stacks) — reconstructing stacks from container labels missed both. So
 * the caller takes stacks from /api/stacks and standalone containers from here,
 * instead of {@link groupContainersForBackup} (which does both from labels).
 */
export function standaloneContainers(
	containers: RawContainer[] | null | undefined
): BackupItem[] {
	if (!Array.isArray(containers)) return [];
	return containers
		.filter((c) => !composeProject(c))
		.map((c): BackupItem => ({
			name: containerName(c),
			type: 'container',
			volumes: normalizeMounts(c.mounts || c.Mounts)
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}
