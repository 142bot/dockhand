<script lang="ts">
	import type { Component } from 'svelte';
	import { Box } from 'lucide-svelte';
	import { appSettings } from '$lib/stores/settings';
	import { selfhstMatcher, ensureSelfhstMatcher } from '$lib/stores/selfhst-refs';
	import { isSelfhstIcon, selfhstRef, isCustomIcon, getStackIconComponent } from '$lib/utils/icons';

	interface Props {
		image: string;
		/** Container name, used as a fallback match when the image does not resolve. */
		name?: string;
		/**
		 * A user-set icon override (lucide name / 'selfhst:<ref>' / 'custom:container').
		 * When present it WINS over automatic matching and renders even with the app-logo
		 * toggle off - an explicit choice always shows. `envId` builds the custom-icon URL.
		 */
		override?: string | null;
		/** Environment id, only needed to fetch a 'custom:' override's bytes. */
		envId?: number | null;
		class?: string;
		/** Extra classes for the generic-box fallback (e.g. a running/stopped state colour). */
		fallbackClass?: string;
		/** Lucide component to render instead of the generic Box when there is no logo. */
		fallbackIcon?: Component;
		/**
		 * When the app-logo toggle is OFF, render the generic box anyway (used by places
		 * that already showed a box, e.g. the logs/terminal pickers, so they keep their
		 * icon + state colour). Default false: with the toggle off, render nothing (the
		 * container/stack lists opt into icons only when the toggle is on).
		 */
		showFallbackWhenOff?: boolean;
		/**
		 * Render nothing when there is no matched app logo (instead of the generic box).
		 * For dense inline spots (e.g. a volume's "used by" chips) where a box on every
		 * row would be noise - show a logo only when we actually have one.
		 */
		hideWhenNoMatch?: boolean;
	}

	let {
		image,
		name = '',
		override = null,
		envId = null,
		class: className = 'w-4 h-4',
		fallbackClass = 'text-muted-foreground',
		fallbackIcon = undefined,
		showFallbackWhenOff = false,
		hideWhenNoMatch = false
	}: Props = $props();

	const FallbackIcon = $derived(fallbackIcon ?? Box);

	// An explicit override wins over auto-matching (and the app-logo toggle).
	const hasOverride = $derived(!!override);
	const overrideSelfhst = $derived(selfhstRef(override));
	const overrideCustom = $derived(isCustomIcon(override));
	const overrideCustomUrl = $derived(
		overrideCustom && name
			? `/api/container-icons/${encodeURIComponent(name)}${envId != null ? `?env=${envId}` : ''}`
			: ''
	);
	// A non-selfhst, non-custom override is a lucide name.
	const OverrideLucide = $derived(
		hasOverride && !isSelfhstIcon(override) && !overrideCustom ? getStackIconComponent(override || '') : null
	);

	const enabled = $derived($appSettings.useSelfhstIcons);

	// Idempotent (guards on loaded/loading); the $effect fires on mount and again if the
	// toggle flips on later, so no separate onMount is needed.
	$effect(() => {
		if (enabled) ensureSelfhstMatcher();
	});

	// Reactive match: recomputes when the matcher store loads or the image changes.
	const ref = $derived(enabled ? $selfhstMatcher(image, name) : null);
	// A failed <img> load (icon 404'd) falls back to the generic box.
	let imgFailed = $state(false);
	$effect(() => {
		// reset the failure flag when the resolved ref changes
		void ref;
		imgFailed = false;
	});

	// Show the fallback glyph when the toggle is on (no logo matched) or a caller that
	// always had an icon asked for it while off - but never on dense inline spots.
	const showFallback = $derived(!hideWhenNoMatch && (enabled || showFallbackWhenOff));
</script>

{#if hasOverride && overrideSelfhst}
	<img src="/api/icons/selfhst/{overrideSelfhst}" alt="" class="{className} object-contain shrink-0" />
{:else if hasOverride && overrideCustom && overrideCustomUrl}
	<img src={overrideCustomUrl} alt="" class="{className} object-contain shrink-0" />
{:else if hasOverride && OverrideLucide}
	<OverrideLucide class="{className} shrink-0" />
{:else if enabled && ref && !imgFailed}
	<img
		src="/api/icons/selfhst/{ref}"
		alt=""
		class="{className} object-contain shrink-0"
		onerror={() => (imgFailed = true)}
	/>
{:else if showFallback}
	<!-- Generic icon so the layout stays consistent even with no match. -->
	<FallbackIcon class="{className} shrink-0 {fallbackClass}" />
{/if}
