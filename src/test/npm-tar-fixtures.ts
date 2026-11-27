import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

// Shared npm-registry and tar fixtures for the CLI/runtime installer tests.

/** A ustar header; prefix carries the leading directories of a long name. */
export function tarHeader(name: string, size: number, type = "0", prefix = ""): Buffer {
	const block = Buffer.alloc(512);
	block.write(name, 0, 100, "utf8");
	block.write("0000755\0", 100, 8, "latin1");
	block.write("0000000\0", 108, 8, "latin1");
	block.write("0000000\0", 116, 8, "latin1");
	block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
	block.write("00000000000\0", 136, 12, "latin1");
	block.write("        ", 148, 8, "latin1");
	block.write(type, 156, 1, "latin1");
	block.write("ustar\0", 257, 6, "latin1");
	block.write("00", 263, 2, "latin1");
	if (prefix) {
		block.write(prefix, 345, 155, "utf8");
	}
	let sum = 0;
	for (const byte of block) {
		sum += byte;
	}
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
	return block;
}

export function tarPadded(data: Buffer): Buffer {
	const rest = data.length % 512;
	return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

export function tarFile(name: string, content: string, prefix = ""): Buffer {
	const data = Buffer.from(content, "utf8");
	return Buffer.concat([tarHeader(name, data.length, "0", prefix), tarPadded(data)]);
}

export function tarDirectory(name: string): Buffer {
	return tarHeader(name, 0, "5");
}

/** A pax header naming the next entry; the record length counts its own digits. */
export function tarPaxPath(value: string): Buffer {
	const body = ` path=${value}\n`;
	let length = body.length + 1;
	while (`${length}${body}`.length !== length) {
		length += 1;
	}
	const data = Buffer.from(`${length}${body}`, "utf8");
	return Buffer.concat([tarHeader("PaxHeader", data.length, "x"), tarPadded(data)]);
}

export function tarGzip(entries: Buffer[]): Buffer {
	return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

export function sri(data: Buffer): string {
	return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

export interface FakeRegistry {
	fetch: (url: string) => Promise<Response>;
	requests: string[];
}

export interface FakeRoute {
	/** Matched against the end of the request URL. */
	suffix: string;
	respond: () => Response;
}

export function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

export function tarballResponse(tgz: Buffer): Response {
	return new Response(new Uint8Array(tgz), { headers: { "content-length": String(tgz.length) } });
}

export function fakeRegistry(routes: readonly FakeRoute[], requests: string[] = []): FakeRegistry {
	return {
		requests,
		fetch: async url => {
			requests.push(url);
			const route = routes.find(candidate => url.endsWith(candidate.suffix));
			return route ? route.respond() : new Response("not found", { status: 404 });
		},
	};
}
