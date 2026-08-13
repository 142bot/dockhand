/**
 * Pure HostConfig sanitizers for container recreation (auto-update).
 *
 * recreateContainerFromInspect passes the OLD container's whole HostConfig back to
 * create. Some fields the daemon REPORTS on inspect it REJECTS on create - notably on
 * Podman, whose inspect is less normalized than Docker's. These fixups run in-place
 * just before create.
 */

interface CpuHostConfig {
	NanoCpus?: number;
	CpuPeriod?: number;
	CpuQuota?: number;
}

/**
 * NanoCpus and CpuPeriod/CpuQuota are two encodings of the same CPU limit and are
 * mutually exclusive at create time. Podman's inspect reports BOTH the absolute
 * NanoCpus and the derived period/quota, so replaying the HostConfig trips its
 * "NanoCpus conflicts with CpuPeriod and CpuQuota" error (#1381). Keep NanoCpus (the
 * direct `cpus:` equivalent) and drop the derived pair. Docker reports period/quota as
 * 0 for a `--cpus` container, so the condition never fires there - zero change for
 * Docker, and no effect when a container uses only one of the two encodings.
 *
 * Mutates `hostConfig` in place. Returns true when it dropped the pair.
 */
export function resolveNanoCpusConflict(hostConfig: CpuHostConfig | null | undefined): boolean {
	if (!hostConfig) return false;
	if (!hostConfig.NanoCpus) return false;
	if (!hostConfig.CpuPeriod && !hostConfig.CpuQuota) return false;
	delete hostConfig.CpuPeriod;
	delete hostConfig.CpuQuota;
	return true;
}
