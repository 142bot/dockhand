import type { Component } from 'svelte';
import { KeyRound } from 'lucide-svelte';
import OnePassword from './OnePassword.svelte';
import Infisical from './Infisical.svelte';
import HashiCorpVault from './HashiCorpVault.svelte';
import Doppler from './Doppler.svelte';

/** Brand icon for a secret-provider type. Falls back to a generic key icon. */
export function getProviderIcon(type: string): Component {
	switch (type) {
		case 'op-service-account':
		case 'op-connect':
			return OnePassword;
		case 'infisical':
			return Infisical;
		case 'vault':
			return HashiCorpVault;
		case 'doppler':
			return Doppler;
		default:
			return KeyRound; // any future provider until it has a brand icon
	}
}
