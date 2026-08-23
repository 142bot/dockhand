<script lang="ts">
	import { getStackIconComponent, isSelfhstIcon, selfhstRef, isCustomIcon } from '$lib/utils/icons';

	interface Props {
		/** Icon value: a lucide name, 'selfhst:<ref>', 'custom:<file>', or null/empty. */
		icon?: string | null;
		/** Stack name, used to build the custom-icon URL. */
		stackName?: string;
		/** Environment id the stack belongs to (custom icons are keyed by name+env). */
		envId?: number | null;
		class?: string;
	}

	let { icon, stackName, envId = null, class: className = 'w-4 h-4' }: Props = $props();

	const customUrl = $derived(
		stackName
			? `/api/stacks/${encodeURIComponent(stackName)}/icon${envId != null ? `?env=${envId}` : ''}`
			: ''
	);

	const selfhst = $derived(selfhstRef(icon));
	const custom = $derived(isCustomIcon(icon));
	// Lucide is the fallback for any non-selfhst, non-custom value (incl. null).
	const LucideIcon = $derived(!isSelfhstIcon(icon) && !custom ? getStackIconComponent(icon || '') : null);
</script>

{#if selfhst}
	<img src="/api/icons/selfhst/{selfhst}" alt="" class="{className} object-contain shrink-0" />
{:else if custom && customUrl}
	<img src={customUrl} alt="" class="{className} object-contain shrink-0" />
{:else if LucideIcon}
	<LucideIcon class={className} />
{/if}
