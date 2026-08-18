/**
 * Pure context assembly - NO docker.ts import (which pulls better-sqlite3 and can't
 * load under the bun unit runner). buildValidateContext (context.ts) fetches the live
 * lists and calls this; unit tests import only this file.
 */

import type { ValidateContext } from './types';

/** Minimal shapes the pure builder needs (subset of docker.ts types). */
export interface CtxContainer {
	name: string;
	ports?: Array<{ PublicPort?: number }>;
}

/**
 * Given the env's containers/networks/volumes, produce the ValidateContext. Excludes
 * THIS stack's own containers so a re-deploy isn't flagged as a self-collision (compose
 * names its containers `<project>-<svc>-<n>`).
 */
export function deriveContextFromLists(
	containers: CtxContainer[],
	networkNames: string[],
	volumeNames: string[],
	selfStackName?: string
): ValidateContext {
	const usedHostPorts = new Set<number>();
	const hostPortOwners = new Map<number, string>();
	const existingContainerNames = new Set<string>();
	for (const c of containers) {
		const isSelf = !!selfStackName && c.name.startsWith(`${selfStackName}-`);
		if (isSelf) continue;
		existingContainerNames.add(c.name);
		for (const p of c.ports || []) {
			if (typeof p.PublicPort === 'number' && p.PublicPort > 0) {
				usedHostPorts.add(p.PublicPort);
				// First writer wins; a port maps to one publishing container.
				if (!hostPortOwners.has(p.PublicPort)) hostPortOwners.set(p.PublicPort, c.name);
			}
		}
	}
	return {
		selfStackName,
		usedHostPorts,
		hostPortOwners,
		existingContainerNames,
		existingNetworks: new Set(networkNames.filter(Boolean)),
		existingVolumes: new Set(volumeNames.filter(Boolean))
	};
}
