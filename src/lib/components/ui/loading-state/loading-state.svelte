<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import { cn } from '$lib/utils.js';

	interface Props {
		/** Optional label under the spinner, e.g. "Loading snapshots...". */
		label?: string;
		/** Extra classes on the wrapper (e.g. `h-full` to fill a flex parent). */
		class?: string;
		/** Spinner size class. Defaults to a large centered spinner. */
		spinnerClass?: string;
	}

	let { label, class: className, spinnerClass = 'w-10 h-10' }: Props = $props();
</script>

<div class={cn('flex min-h-[200px] flex-col items-center justify-center gap-3 text-muted-foreground', className)}>
	<Loader2 class={cn('animate-spin', spinnerClass)} />
	{#if label}
		<span class="text-sm">{label}</span>
	{/if}
</div>
