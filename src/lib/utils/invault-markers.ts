/**
 * Pure classification for the stack editor's live provider marker.
 *
 * A compose ${VAR} that is not defined locally is normally red MISSING. When a
 * secret provider is bound, we live-probe it: if the key exists in the provider
 * it becomes green IN VAULT instead. If the probe failed (provider unreachable /
 * bad token / bad path) we keep the old red MISSING - never a false green.
 */

export type InVaultMarkerType = 'required' | 'missing' | 'invault';

/**
 * Classifies one required compose var. `providerKeySet` is the set of key names
 * the live probe confirmed present in the bound provider. `probeFailed` forces
 * MISSING (we can't vouch for the key when the probe didn't succeed).
 */
export function classifyMarker(
	name: string,
	isMissing: boolean,
	providerKeySet: Set<string>,
	probeFailed: boolean
): InVaultMarkerType {
	if (!isMissing) return 'required';
	if (!probeFailed && providerKeySet.has(name)) return 'invault';
	return 'missing';
}

/**
 * Given the inline op:// (or other provider) references the client submitted as
 * `{ varName, ref }` pairs and the SUBSET of ref STRINGS the provider resolved,
 * returns the VAR NAMES whose ref resolved. `resolveSecretReferences` keys its
 * result by the ref string, not the var name, so the caller maps it back here.
 */
export function resolvedRefVarNames(
	refPairs: { varName: string; ref: string }[],
	resolvedRefs: string[]
): string[] {
	const resolved = new Set(resolvedRefs);
	return refPairs.filter((p) => resolved.has(p.ref)).map((p) => p.varName);
}
