export interface FileReference {
	/** Local path without the position suffix. file: URIs are decoded to a path. */
	path: string;
	/** 1-based line, column and last line of a range. */
	line?: number;
	column?: number;
	endLine?: number;
}

function decode(value: string): string {
	try { return decodeURIComponent(value); } catch { return value; }
}

function position(value: string): Omit<FileReference, "path"> {
	const match = /^(?:L)?(\d+)(?:(?:C|:)(\d+)|-(?:L)?(\d+))?$/i.exec(value);
	if (!match) { return {}; }
	const valid = (s: string | undefined) => {
		const n = Number(s);
		return s !== undefined && n >= 1 && n <= 10_000_000 ? n : undefined;
	};
	const line = valid(match[1]);
	if (!line || (match[2] && !valid(match[2])) || (match[3] && !valid(match[3]))) { return {}; }
	const column = valid(match[2]);
	const end = valid(match[3]);
	return { line, ...(column ? { column } : {}), ...(end && end >= line ? { endLine: end } : {}) };
}

/** Parses a link destination or inline-code path. */
export function parseFileReference(target: string): FileReference | undefined {
	let value = target.trim();
	if ((value.startsWith("<") && value.endsWith(">")) || (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")) || (value.startsWith("`") && value.endsWith("`"))) {
		value = value.slice(1, -1);
	}
	if (!value || value.length > 1024 || /[\0\r\n]/.test(value) || /_vscodecontentref_/i.test(value) || /^(?:\\\\|\/\/)/.test(value)) { return undefined; }
	const isFile = /^file:/i.test(value);
	const pathWithPosition = /^[^:]*[./\\][^:]*:\d+(?::\d+|-\d+)?$/.test(value.split(/[?#]/, 1)[0]);
	if (!isFile && !pathWithPosition && !/^[a-z]:[\\/]/i.test(value) && /^[a-z][a-z0-9+.-]*:/i.test(value)) { return undefined; }
	if (isFile) {
		const uri = /^file:\/\/(?:([^/]*))?(\/.*)$/i.exec(value);
		if (!uri || (uri[1] && uri[1].toLowerCase() !== "localhost")) { return undefined; }
		value = uri[2];
	}
	const hash = value.indexOf("#");
	const query = value.indexOf("?");
	let pos: Omit<FileReference, "path"> = {};
	if (hash >= 0 && (query < 0 || hash < query)) {
		pos = position(value.slice(hash + 1).split("?")[0]);
	}
	value = value.slice(0, Math.min(...[hash, query].filter(n => n >= 0), value.length));
	if (isFile || /%[0-9a-f]{2}/i.test(value)) { value = decode(value); }
	if (isFile && /^\/[a-z]:\//i.test(value)) { value = value.slice(1); }
	const suffix = /:(\d+(?::\d+|-\d+)?)$/.exec(value);
	if (suffix && !(suffix.index === 1 && /^[a-z]:/i.test(value))) {
		if (pos.line === undefined) { pos = position(suffix[1]); }
		value = value.slice(0, suffix.index);
	}
	if (!value || /^(?:\.{1,2}|[\\/])+$/.test(value) || /^(?:\\\\|\/\/)/.test(value) || /[\0\r\n]/.test(value)) { return undefined; }
	return { path: value, ...pos };
}

/** Returns a local Markdown link destination without surrounding angle brackets. */
export function linkFileTarget(href: string): string | undefined {
	let value = href.trim();
	if (value.startsWith("<") && value.endsWith(">")) { value = value.slice(1, -1); }
	return value && !value.startsWith("#") && parseFileReference(value) ? value : undefined;
}

const extensions = new Set("ts tsx mts cts js jsx mjs cjs json jsonc jsonl md mdx txt log py pyi rs go java kt kts c h cc cpp hpp cs rb php swift scala sh bash zsh ps1 psm1 bat cmd css scss less html htm vue svelte xml svg yml yaml toml ini cfg conf sql csv tsv lock png jpg jpeg gif webp bmp ico pdf ipynb gradle properties proto graphql dart lua tf hcl cmake patch diff vsix env".split(" "));
const names = new Set(".gitignore .gitattributes .vscodeignore .npmrc .editorconfig .env .prettierrc .eslintrc Dockerfile Makefile LICENSE".split(" "));

/** Returns inline code only when it strictly resembles a file path. */
export function codeFileTarget(code: string): string | undefined {
	const value = code.trim();
	if (value.length < 3 || value.length > 260 || /[\s`()=,;'"><>|*?{}[\]]/.test(value) || value.includes("://") || /^(?:node|next|vue|nuxt|three|d3|chart|ember|backbone)\.js$/i.test(value)) { return undefined; }
	if (value.includes("#") && !/#L\d+(?:-L?\d+)?$/i.test(value)) { return undefined; }
	const ref = parseFileReference(value);
	if (!ref) { return undefined; }
	let path = ref.path.replace(/^[a-z]:[\\/]/i, "").replace(/^[\\/]/, "");
	const segments = path.split(/[\\/]/);
	while (segments[0] === "." || segments[0] === "..") { segments.shift(); }
	if (!segments.length || segments.some(s => !/^[\p{L}\p{N}_.@+~$-]+$/u.test(s))) { return undefined; }
	path = segments[segments.length - 1];
	const ext = /\.([^.]+)$/.exec(path)?.[1].toLowerCase();
	return names.has(path) || (ext && extensions.has(ext)) ? value : undefined;
}
