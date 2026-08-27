/**
 * probeBulkKeysCached: result cache (~30s, names only) + single-flight coalescing.
 * The single-flight guard stops overlapping stack-editor probes from each hitting the
 * provider (wasted 1Password/Vault API calls; a burst of keepassxc-cli/bws spawns).
 */
import { describe, it, expect } from 'bun:test';
import { probeBulkKeysCached } from '../src/lib/server/secretproviders/probe-cache';

// A provider whose resolveBulk is slow and counts its own calls. Cast to the
// SecretProvider shape (only resolveBulk is exercised here).
function countingProvider(delayMs = 30) {
	let calls = 0;
	const provider: any = {
		supportsBulk: true,
		async resolveBulk() {
			calls++;
			await new Promise((r) => setTimeout(r, delayMs));
			return { KEY_A: 'a', KEY_B: 'b' };
		}
	};
	return { provider, calls: () => calls };
}

describe('probeBulkKeysCached', () => {
	it('coalesces concurrent probes for the same (provider, selector) into ONE call', async () => {
		const { provider, calls } = countingProvider();
		const id = 1001; // unique id so cache/inflight don't collide with other tests
		const results = await Promise.all(
			Array.from({ length: 10 }, () => probeBulkKeysCached(id, provider, {} as any, 'grp'))
		);
		expect(calls()).toBe(1); // single-flight: 10 concurrent -> 1 provider call
		// every caller still gets the same key names
		for (const r of results) expect(r.sort()).toEqual(['KEY_A', 'KEY_B']);
	});

	it('serves the cached result on a later call without re-calling the provider', async () => {
		const { provider, calls } = countingProvider();
		const id = 1002;
		await probeBulkKeysCached(id, provider, {} as any, 'grp');
		await probeBulkKeysCached(id, provider, {} as any, 'grp');
		expect(calls()).toBe(1); // second call hit the ~30s cache
	});

	it('does NOT coalesce different selectors', async () => {
		const { provider, calls } = countingProvider();
		const id = 1003;
		await Promise.all([
			probeBulkKeysCached(id, provider, {} as any, 'grp-a'),
			probeBulkKeysCached(id, provider, {} as any, 'grp-b')
		]);
		expect(calls()).toBe(2); // distinct keys -> distinct calls
	});

	it('re-probes (does not serve a stale entry) once the TTL has elapsed', async () => {
		// The cache TTL is 30s; we can't wait that long, so drive it by advancing the
		// clock via a stubbed Date.now. A stale hit must be dropped and re-fetched.
		const { provider, calls } = countingProvider();
		const id = 1005;
		const realNow = Date.now;
		try {
			let t = 1_000_000;
			(Date as any).now = () => t;
			await probeBulkKeysCached(id, provider, {} as any, 'grp'); // call 1, cached at t
			t += 31_000; // jump past the 30s TTL
			await probeBulkKeysCached(id, provider, {} as any, 'grp'); // stale -> call 2
			expect(calls()).toBe(2);
		} finally {
			(Date as any).now = realNow;
		}
	});

	it('does not cache a failure, and a later probe retries', async () => {
		let calls = 0;
		const provider: any = {
			supportsBulk: true,
			async resolveBulk() {
				calls++;
				if (calls === 1) throw new Error('transient');
				return { OK: 'v' };
			}
		};
		const id = 1004;
		await expect(probeBulkKeysCached(id, provider, {} as any, 'grp')).rejects.toThrow('transient');
		// the in-flight entry must have been cleared, so this retries rather than
		// returning a stale/failed promise
		const keys = await probeBulkKeysCached(id, provider, {} as any, 'grp');
		expect(keys).toEqual(['OK']);
		expect(calls).toBe(2);
	});
});
