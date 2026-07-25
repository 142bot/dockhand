/**
 * backups/tar.ts — a tiny, pure USTAR builder for the backup helper.
 *
 * The backup metadata files (metadata.json, and for stacks the compose/.env and
 * the whole stackfiles/ tree) used to be written into the helper container by
 * embedding each file's base64 as a shell argument in the container Cmd. That
 * blows the kernel ARG_MAX for large stack files (a few MB of base64 on one arg
 * line) and the helper dies with "argument list too long" before restic runs.
 *
 * Instead we ship the files into the container with the Docker put-archive API
 * (docker cp), which streams a tar over HTTP with no arg-length limit. This
 * module builds that tar. Pure (no I/O), so it is unit-testable directly.
 */

export interface TarEntry {
	/** Path inside the archive, e.g. "metadata/stacks/foo/compose.yaml". No leading slash. */
	path: string;
	content: Uint8Array;
}

const BLOCK = 512;

function writeAscii(block: Uint8Array, offset: number, text: string): void {
	const bytes = new TextEncoder().encode(text);
	block.set(bytes, offset);
}

/** Build a POSIX USTAR header block for one regular file. */
function header(path: string, size: number, mtimeSecs: number): Uint8Array {
	const h = new Uint8Array(BLOCK);
	// Name (100). USTAR splits long names into prefix(345)+name(100); our paths
	// are short (metadata/stacks/<name>/stackfiles/<rel>), so the 100-byte name
	// field is enough. Truncation would corrupt the path, so guard callers.
	writeAscii(h, 0, path.slice(0, 100));
	writeAscii(h, 100, '0000644\0'); // mode 0644
	writeAscii(h, 108, '0000000\0'); // uid 0
	writeAscii(h, 116, '0000000\0'); // gid 0
	writeAscii(h, 124, size.toString(8).padStart(11, '0') + '\0'); // size (octal)
	writeAscii(h, 136, mtimeSecs.toString(8).padStart(11, '0') + '\0'); // mtime (octal)
	writeAscii(h, 148, '        '); // checksum placeholder (spaces) while summing
	h[156] = 48; // type flag '0' = regular file
	writeAscii(h, 257, 'ustar\0'); // magic
	writeAscii(h, 263, '00'); // version
	writeAscii(h, 265, 'root');
	writeAscii(h, 297, 'root');

	let checksum = 0;
	for (let i = 0; i < BLOCK; i++) checksum += h[i];
	writeAscii(h, 148, checksum.toString(8).padStart(6, '0') + '\0 ');
	return h;
}

/**
 * Build a USTAR archive from the given entries. Paths longer than 100 bytes are
 * rejected (the callers use short, bounded paths) rather than silently truncated.
 * `mtimeSecs` is injectable so the builder stays pure/deterministic for tests.
 */
export function buildTar(entries: TarEntry[], mtimeSecs = Math.floor(Date.now() / 1000)): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const e of entries) {
		const path = e.path.replace(/^\/+/, '');
		if (new TextEncoder().encode(path).length > 100) {
			throw new Error(`tar entry path too long for USTAR name field (>100 bytes): ${path}`);
		}
		blocks.push(header(path, e.content.length, mtimeSecs));
		const padded = Math.ceil(e.content.length / BLOCK) * BLOCK;
		const body = new Uint8Array(padded);
		body.set(e.content, 0);
		blocks.push(body);
	}
	// Two zero blocks terminate the archive.
	blocks.push(new Uint8Array(BLOCK));
	blocks.push(new Uint8Array(BLOCK));

	const total = blocks.reduce((n, b) => n + b.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const b of blocks) { out.set(b, off); off += b.length; }
	return out;
}
