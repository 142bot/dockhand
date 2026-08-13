<script lang='ts' module>
	export interface SecretProvider {
		id: number;
		type: string;
		name: string;
		createdAt: string;
		updatedAt?: string;
	}

	interface ProviderField {
		key: string;
		label: string;
		type: 'text' | 'password';
		required: boolean;
		placeholder?: string;
		hint?: string;
	}

	// Selectable provider types + their labels. Mirrors the registered providers
	// in src/lib/server/secretproviders (index.ts / shared.ts).
	export const PROVIDER_TYPES: { value: string; label: string }[] = [
		{ value: 'op-service-account', label: '1Password service account' },
		{ value: 'op-connect', label: '1Password Connect' },
		{ value: 'infisical', label: 'Infisical' },
		{ value: 'vault', label: 'HashiCorp Vault' },
		{ value: 'doppler', label: 'Doppler' },
	];

	// Config fields per provider type, matching the config shapes in
	// secretproviders/shared.ts. Non-required fields are optional overrides.
	export const PROVIDER_FIELDS: Record<string, ProviderField[]> = {
		'op-service-account': [
			{ key: 'token', label: 'Service account token', type: 'password', required: true, placeholder: 'ops_eyJ...' },
		],
		'op-connect': [
			{ key: 'host', label: 'Connect host URL', type: 'text', required: true, placeholder: 'https://connect.example.com' },
			{ key: 'token', label: 'Connect token', type: 'password', required: true, placeholder: 'eyJ...' },
		],
		infisical: [
			{ key: 'host', label: 'API host', type: 'text', required: true, placeholder: 'https://app.infisical.com' },
			{ key: 'token', label: 'Access token', type: 'password', required: true, placeholder: 'st...' },
			{ key: 'projectId', label: 'Project ID', type: 'text', required: true, placeholder: 'workspace / project id' },
			{ key: 'environment', label: 'Environment', type: 'text', required: true, placeholder: 'prod' },
			{ key: 'path', label: 'Secret path', type: 'text', required: false, placeholder: '/' },
		],
		vault: [
			{ key: 'address', label: 'Vault address', type: 'text', required: true, placeholder: 'https://vault.example.com' },
			{ key: 'token', label: 'Vault token', type: 'password', required: true, placeholder: 'hvs...' },
			{ key: 'namespace', label: 'Namespace', type: 'text', required: false, placeholder: 'admin (Enterprise / HCP)' },
			{ key: 'mount', label: 'KV mount', type: 'text', required: false, placeholder: 'secret' },
		],
		doppler: [
			{ key: 'token', label: 'Token', type: 'password', required: true, placeholder: 'dp.st.... or dp.pt....', hint: 'A service token (dp.st.) already targets one config. A personal token (dp.pt.) also needs the project and config below.' },
			{ key: 'project', label: 'Project', type: 'text', required: false, placeholder: 'only for a personal token (dp.pt.)' },
			{ key: 'config', label: 'Config', type: 'text', required: false, placeholder: 'e.g. prd' },
		],
	};

	export function providerTypeLabel(type: string): string {
		return PROVIDER_TYPES.find((t) => t.value === type)?.label ?? type;
	}
</script>

<script lang='ts'>
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { FieldLabel } from '$lib/components/ui/field-label';
	import { Input } from '$lib/components/ui/input';
	import { Plus, Check, RefreshCw, PlugZap, KeyRound } from 'lucide-svelte';
	import { scale } from 'svelte/transition';
	import { backOut, cubicIn } from 'svelte/easing';
	import { getProviderIcon } from '$lib/components/provider-icons';
	import { toast } from 'svelte-sonner';
	import { focusFirstInput } from '$lib/utils';

	interface Props {
		open: boolean;
		provider?: SecretProvider | null;
		onClose: () => void;
		onSaved: () => void;
	}

	let {
		open = $bindable(),
		provider = null,
		onClose,
		onSaved,
	}: Props = $props();

	const isEditing = $derived(provider !== null);

	let formName = $state('');
	let formType = $state('op-service-account');
	// One value per config field; blank means 'unset' (on edit: keep existing).
	let formConfig = $state<Record<string, string>>({});
	let formError = $state('');
	let formSaving = $state(false);
	let formTesting = $state(false);
	// Brief green tick on the Test connection button right after a successful test.
	let testOk = $state(false);
	let testOkTimer: ReturnType<typeof setTimeout> | undefined;

	const fields = $derived(PROVIDER_FIELDS[formType] ?? []);

	function resetConfig() {
		formConfig = {};
	}

	function resetForm() {
		formName = '';
		formType = 'op-service-account';
		resetConfig();
		formError = '';
		formSaving = false;
		formTesting = false;
	}

	$effect(() => {
		if (open) {
			if (provider) {
				formName = provider.name;
				formType = provider.type;
				resetConfig();
				formError = '';
				// Pre-fill the NON-secret config fields (host, projectId, mount, ...) from
				// the server; the token stays blank ('keep existing'). The list only has a
				// summary, so fetch the single provider which returns the redacted config.
				void loadProviderConfig(provider.id);
			} else {
				resetForm();
			}
		}
	});

	async function loadProviderConfig(id: number) {
		try {
			const res = await fetch(`/api/secret-providers/${id}`);
			if (!res.ok) return;
			const data = await res.json();
			const cfg = (data?.config ?? {}) as Record<string, unknown>;
			const next: Record<string, string> = {};
			for (const [key, value] of Object.entries(cfg)) {
				if (value != null) next[key] = String(value);
			}
			formConfig = next; // secret fields (token) are absent -> stay blank
		} catch {
			// leave fields blank on failure - the user can re-enter them
		}
	}

	// A blank secret field on edit means "keep the stored value"; non-secret fields are
	// pre-filled (loadProviderConfig). Collect only the fields the user actually filled.
	function collectConfig(): Record<string, string> {
		const config: Record<string, string> = {};
		for (const field of fields) {
			const value = (formConfig[field.key] ?? '').trim();
			if (value) config[field.key] = value;
		}
		return config;
	}

	function missingRequired(config: Record<string, string>, editing = false): string | null {
		for (const field of fields) {
			// On edit a blank secret (password) field keeps the stored value, so it is
			// allowed to be empty; non-secret required fields still must be present.
			if (editing && field.type === 'password') continue;
			if (field.required && !config[field.key]) {
				return `${field.label} is required`;
			}
		}
		return null;
	}

	function onTypeChange(value: string) {
		formType = value;
		// Fields differ per type; drop any stale values.
		resetConfig();
		formError = '';
	}

	async function testCurrent() {
		formTesting = true;
		formError = '';
		try {
			const config = collectConfig();
			// On edit the token is server-side (blank field = keep stored), so if the
			// user hasn't typed a new one, test the STORED config; the pre-filled
			// non-secret fields aren't enough to re-test from the client.
			const hasNewSecret = fields.some((f) => f.type === 'password' && (config[f.key] ?? '') !== '');

			let response: Response;
			if (isEditing && !hasNewSecret) {
				// Test the stored (server-side) config.
				response = await fetch(`/api/secret-providers/${provider!.id}/test`, {
					method: 'POST',
				});
			} else {
				const missing = missingRequired(config, isEditing);
				if (missing) {
					formError = missing;
					return;
				}
				response = await fetch('/api/secret-providers/test', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ type: formType, config }),
				});
			}
			const data = await response.json();
			if (data.ok) {
				toast.success('Connection works');
				clearTimeout(testOkTimer);
				testOk = true;
				testOkTimer = setTimeout(() => (testOk = false), 2000);
			} else {
				toast.error(data.error || 'Connection failed');
				formError = data.error || 'Connection failed';
			}
		} catch {
			toast.error('Connection test failed');
		} finally {
			formTesting = false;
		}
	}

	async function save() {
		if (!formName.trim()) {
			formError = 'Name is required';
			return;
		}

		const config = collectConfig();

		// On create, every required field must be present. On EDIT, a blank SECRET
		// field (token) means "keep the stored value", so a required secret is allowed
		// to be blank; non-secret required fields (host, projectId, ...) are pre-filled
		// and still validated. The backend merges the stored secret over the blank.
		const missing = missingRequired(config, isEditing);
		if (missing) {
			formError = missing;
			return;
		}

		formSaving = true;
		formError = '';

		try {
			const body: Record<string, unknown> = {
				name: formName.trim(),
				type: formType,
				// Always send config; on edit the backend keeps the stored secret when a
				// secret field is blank (updateSecretProvider merges), and the non-secret
				// fields are pre-filled, so `config` is the full intended coordinates.
				config,
			};

			const url = isEditing
				? `/api/secret-providers/${provider!.id}`
				: '/api/secret-providers';
			const method = isEditing ? 'PUT' : 'POST';

			const response = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});

			if (response.ok) {
				open = false;
				onSaved();
			} else {
				const data = await response.json();
				formError =
					data.error ||
					`Failed to ${isEditing ? 'update' : 'create'} secret provider`;
			}
		} catch {
			formError = `Failed to ${isEditing ? 'update' : 'create'} secret provider`;
		} finally {
			formSaving = false;
		}
	}

	function handleClose() {
		clearTimeout(testOkTimer);
		testOk = false;
		open = false;
		onClose();
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(o) => {
		if (o) {
			formError = "";
			focusFirstInput();
		}
	}}
>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<KeyRound class="w-5 h-5 text-muted-foreground" />
				{isEditing ? "Edit" : "Add"} secret provider
			</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4">
			{#if formError}
				<div class="text-sm text-red-600 dark:text-red-400">
					{formError}
				</div>
			{/if}
			<div class="space-y-2">
				<FieldLabel label="Name" forId="provider-name" required showOptional={false} />
				<Input
					id="provider-name"
					bind:value={formName}
					placeholder="Production secrets"
				/>
			</div>
			<div class="space-y-2 sm:w-[calc(50%-0.5rem)]">
				<FieldLabel label="Provider" forId="provider-type" required showOptional={false} />
				<Select.Root
					type="single"
					value={formType}
					onValueChange={onTypeChange}
					disabled={isEditing}
				>
					<Select.Trigger id="provider-type" class="flex w-full items-center gap-2">
						{@const TriggerIcon = getProviderIcon(formType)}
						<TriggerIcon class="w-4 h-4 shrink-0 text-muted-foreground" />
						{providerTypeLabel(formType)}
					</Select.Trigger>
					<Select.Content>
						{#each PROVIDER_TYPES as t (t.value)}
							{@const ItemIcon = getProviderIcon(t.value)}
							<Select.Item value={t.value} label={t.label}>
								<span class="flex items-center gap-2">
									<ItemIcon class="w-4 h-4 shrink-0 text-muted-foreground" />
									{t.label}
								</span>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<!-- Provider config fields in a 2-column grid. min-height fits the tallest
			     provider (5 fields = 3 rows) so the modal keeps a fixed height and does
			     not jump when switching providers. -->
			<div class="grid grid-cols-2 gap-x-4 gap-y-3" style="min-height: 13.5rem;">
				{#each fields as field (field.key)}
					<div class="space-y-2">
						<FieldLabel label={field.label} forId={`provider-${field.key}`} required={field.required} />
						<Input
							id={`provider-${field.key}`}
							type={field.type}
							bind:value={formConfig[field.key]}
							placeholder={isEditing && field.type === "password"
								? "leave blank to keep existing"
								: field.placeholder}
						/>
						{#if field.hint}
							<p class="text-xs text-muted-foreground">{field.hint}</p>
						{/if}
					</div>
				{/each}
			</div>
			<p class="text-xs text-muted-foreground">
				Configuration is stored encrypted.{#if isEditing}
					Leave secret fields blank to keep the existing values.{/if}
			</p>
		</div>
		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={testCurrent}
				disabled={formTesting || formSaving}
				class={`transition-colors duration-300 ${testOk ? 'border-green-500/60 text-green-600 dark:text-green-400' : ''}`}
			>
				<span class="inline-flex w-4 h-4 mr-1 items-center justify-center shrink-0">
					{#if formTesting}
						<RefreshCw class="w-4 h-4 animate-spin" />
					{:else if testOk}
						<span in:scale={{ duration: 260, start: 0.4, easing: backOut }} out:scale={{ duration: 150, start: 0.6, easing: cubicIn }}>
							<Check class="w-4 h-4 text-green-600 dark:text-green-400" />
						</span>
					{:else}
						<PlugZap class="w-4 h-4" />
					{/if}
				</span>
				Test connection
			</Button>
			<div class="flex-1"></div>
			<Button variant="outline" onclick={handleClose}>Cancel</Button>
			<Button onclick={save} disabled={formSaving}>
				{#if formSaving}
					<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
				{:else if isEditing}
					<Check class="w-4 h-4" />
				{:else}
					<Plus class="w-4 h-4" />
				{/if}
				{isEditing ? "Save" : "Add"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
