/**
 * Decision for whether a git-stack webhook trigger may proceed, given the repository's
 * configured secret and the operator's opt-out env flag. Pure so it is unit-testable
 * without a database or a live request.
 *
 * Default is secure: a secret is required. ALLOW_WEBHOOKS_WITHOUT_SECRET=true lets an
 * operator accept a secret-less trigger on a network the webhook URL never leaves. The
 * opt-out ONLY affects the "no secret configured" case - a repository that HAS a secret
 * is always verified regardless of the flag.
 */
export type WebhookSecretDecision =
	| { action: 'verify' } // a secret is configured; caller must verify the signature/query secret
	| { action: 'deploy-unverified' } // no secret, but the opt-out is on; deploy without verification
	| { action: 'reject-no-secret' }; // no secret and no opt-out; reject 401

export function decideWebhookSecretPolicy(
	hasSecret: boolean,
	allowSecretless: boolean
): WebhookSecretDecision {
	if (hasSecret) return { action: 'verify' };
	if (allowSecretless) return { action: 'deploy-unverified' };
	return { action: 'reject-no-secret' };
}

/** Reads the opt-out env flag. Off unless explicitly set to the string "true". */
export function allowSecretlessWebhook(): boolean {
	return process.env.ALLOW_WEBHOOKS_WITHOUT_SECRET === 'true';
}
