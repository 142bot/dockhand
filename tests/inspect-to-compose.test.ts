/**
 * Unit tests for inspectToCompose - the container-inspect -> compose YAML mapper (#489).
 *
 * Uses REAL `docker inspect` payloads captured from running containers
 * (tests/fixtures/inspect/*.json), so the mapper is exercised against the exact shapes
 * Docker actually emits, not hand-written approximations. Assertions run on the re-parsed
 * YAML object so they are independent of formatting.
 *
 * Run with: bun test tests/inspect-to-compose.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { inspectToCompose, inspectToComposeService, type DockerInspect } from '../src/lib/utils/inspect-to-compose';

function loadFixture(name: string): DockerInspect {
	const path = join(import.meta.dir, 'fixtures', 'inspect', name);
	const arr = JSON.parse(readFileSync(path, 'utf8')) as DockerInspect[];
	return arr[0];
}

function parseCompose(inspect: DockerInspect, options = {}) {
	const yamlStr = inspectToCompose(inspect, options);
	return { yamlStr, doc: yaml.load(yamlStr) as any };
}

describe('inspectToCompose - real gitea inspect (compose-managed, named-vol, custom net)', () => {
	const gitea = loadFixture('gitea.json');

	test('service key is the clean container name', () => {
		const { doc } = parseCompose(gitea);
		expect(Object.keys(doc.services)).toEqual(['semver-demo-stack-gitea-1']);
	});

	test('image + container_name + restart carry through', () => {
		const { doc } = parseCompose(gitea);
		const svc = doc.services['semver-demo-stack-gitea-1'];
		expect(svc.image).toBe('gitea/gitea:1.21.0');
		expect(svc.container_name).toBe('semver-demo-stack-gitea-1');
		expect(svc.restart).toBe('unless-stopped');
	});

	test('the com.docker.compose.* labels are stripped', () => {
		const { yamlStr, doc } = parseCompose(gitea);
		expect(yamlStr).not.toContain('com.docker.compose');
		const svc = doc.services['semver-demo-stack-gitea-1'];
		if (svc.labels) {
			for (const key of Object.keys(svc.labels)) {
				expect(key.startsWith('com.docker.compose.')).toBe(false);
			}
		}
	});

	test('the custom stack network is emitted and declared external at top level', () => {
		const { doc } = parseCompose(gitea);
		const svc = doc.services['semver-demo-stack-gitea-1'];
		expect(svc.networks).toEqual(['semver-demo-stack_default']);
		expect(doc.networks['semver-demo-stack_default']).toEqual({ external: true });
		// bare bridge/default are never emitted
		expect(svc.network_mode).toBeUndefined();
	});

	test('the anonymous (64-hex) volume becomes a bare anonymous mount, not a named one', () => {
		const { doc } = parseCompose(gitea);
		const svc = doc.services['semver-demo-stack-gitea-1'];
		// gitea's /data rides a 64-hex anonymous volume -> `- /data`, no hash name, no top-level volume
		expect(svc.volumes).toContain('/data');
		for (const v of svc.volumes as string[]) {
			expect(v).not.toMatch(/^[0-9a-f]{64}:/);
		}
		expect(doc.volumes).toBeUndefined();
	});
});

describe('inspectToCompose - real nginx inspect (published ports, bind :ro, named vol, healthcheck, caps, sysctl)', () => {
	const nginx = loadFixture('nginx-rich.json');
	const svcName = 'itc-fixture';

	test('published ports map to host:container, respecting a bound host IP', () => {
		const { doc } = parseCompose(nginx);
		const svc = doc.services[svcName];
		expect(svc.ports).toContain('8099:80');
		expect(svc.ports).toContain('127.0.0.1:8443:443');
	});

	test('bind mount is source:dest with :ro; named volume is name:dest + top-level external', () => {
		const { doc } = parseCompose(nginx);
		const svc = doc.services[svcName];
		expect(svc.volumes).toContain('/tmp/itc-html:/usr/share/nginx/html:ro');
		expect(svc.volumes).toContain('itc-named:/var/cache/nginx');
		expect(doc.volumes['itc-named']).toEqual({ external: true });
	});

	test('restart on-failure keeps its retry count', () => {
		const { doc } = parseCompose(nginx);
		expect(doc.services[svcName].restart).toBe('on-failure:5');
	});

	test('cap_add/cap_drop and sysctls carry through', () => {
		const { doc } = parseCompose(nginx);
		const svc = doc.services[svcName];
		expect(svc.cap_add).toContain('CAP_NET_ADMIN');
		expect(svc.cap_drop).toContain('CAP_MKNOD');
		expect(svc.sysctls['net.core.somaxconn']).toBe('1024');
	});

	test('healthcheck maps Test + interval(ns->s) + retries', () => {
		const { doc } = parseCompose(nginx);
		const hc = doc.services[svcName].healthcheck;
		expect(hc.test).toEqual(['CMD-SHELL', 'curl -f http://localhost/ || exit 1']);
		expect(hc.interval).toBe('30s');
		expect(hc.retries).toBe(3);
	});

	test('custom label survives', () => {
		const { doc } = parseCompose(nginx);
		expect(doc.services[svcName].labels['my.custom.label']).toBe('hello');
	});

	test('image-baked labels (maintainer) are dropped when imageLabels is provided; user label stays', () => {
		// The image sets maintainer; the container adds my.custom.label. With the image labels
		// passed, only the user-added one survives.
		const imageLabels = { maintainer: 'NGINX Docker Maintainers <docker-maint@nginx.com>' };
		const { doc } = parseCompose(nginx, { imageLabels });
		const labels = doc.services[svcName].labels;
		expect(labels.maintainer).toBeUndefined();
		expect(labels['my.custom.label']).toBe('hello');
	});

	test('auto-generated noise (hostname, working_dir /, shm_size) is not emitted', () => {
		const { doc } = parseCompose(nginx);
		const svc = doc.services[svcName];
		// Hostname is the short container id (12-hex) -> dropped; working_dir is "/" -> dropped;
		// shm_size is host-derived -> never emitted.
		expect(svc.hostname).toBeUndefined();
		expect(svc.working_dir).toBeUndefined();
		expect(svc.shm_size).toBeUndefined();
	});

	test('image-default entrypoint/command are dropped when the image values are provided', () => {
		const imageEntrypoint = nginx.Config?.Entrypoint ?? null;
		const imageCmd = nginx.Config?.Cmd ?? null;
		const { doc } = parseCompose(nginx, { imageEntrypoint, imageCmd });
		const svc = doc.services[svcName];
		// nginx's entrypoint+cmd come from the image, so with the image passed they vanish.
		expect(svc.entrypoint).toBeUndefined();
		expect(svc.command).toBeUndefined();
	});

	test('a user-overridden command is KEPT even when the image command is provided', () => {
		const custom = structuredClone(nginx);
		custom.Config!.Cmd = ['nginx', '-g', 'daemon off; worker_processes 4;'];
		const { doc } = parseCompose(custom, { imageCmd: nginx.Config?.Cmd ?? null });
		expect(doc.services[svcName].command).toEqual(['nginx', '-g', 'daemon off; worker_processes 4;']);
	});
});

describe('inspectToCompose - image-env subtraction', () => {
	const nginx = loadFixture('nginx-rich.json');
	const svcName = 'itc-fixture';

	test('without imageEnv, all env (incl. inherited PATH) is kept', () => {
		const { doc } = parseCompose(nginx);
		const env = (doc.services[svcName].environment as string[]) ?? [];
		expect(env.some((e) => e.startsWith('PATH='))).toBe(true);
		expect(env).toContain('MY_VAR=uservalue');
	});

	test('with imageEnv, inherited vars are dropped and only user-set env remains', () => {
		const imageEnv = (nginx.Config?.Env ?? []).filter((e) => !e.startsWith('MY_VAR='));
		const { doc } = parseCompose(nginx, { imageEnv });
		const env = (doc.services[svcName].environment as string[]) ?? [];
		expect(env).toEqual(['MY_VAR=uservalue']);
	});
});

describe('inspectToCompose - default-noise filtering', () => {
	test('an explicit restart "no" and a bare bridge network produce no restart/network keys', () => {
		const minimal: DockerInspect = {
			Name: '/plain',
			Config: { Image: 'busybox:latest' },
			HostConfig: {
				RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
				NetworkMode: 'bridge',
				LogConfig: { Type: 'json-file', Config: {} }
			},
			NetworkSettings: { Networks: { bridge: {} } }
		};
		const { doc } = parseCompose(minimal);
		const svc = doc.services['plain'];
		expect(svc.restart).toBeUndefined();
		expect(svc.networks).toBeUndefined();
		expect(svc.network_mode).toBeUndefined();
		expect(svc.logging).toBeUndefined();
		expect(svc.image).toBe('busybox:latest');
	});

	test('serviceName option overrides the container name', () => {
		const { name } = inspectToComposeService({ Name: '/original', Config: { Image: 'x' } }, { serviceName: 'renamed' });
		expect(name).toBe('renamed');
	});
});
