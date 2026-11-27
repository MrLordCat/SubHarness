// Bundles the compiled extension (out/extension.js and the out/ modules it requires) into one file in place.
// Loading one file instead of ~165 cuts the extension's module load time about in half (225 -> 104 ms measured).
// Runs after `tsc` in vscode:prepublish only: tests and development keep the per-file tsc output.
// npm packages stay external (the SDKs are loaded lazily from node_modules) and so does `vscode`.
import { rename, rm, stat } from "node:fs/promises";
import { build } from "esbuild";

const entry = "out/extension.js";
const bundled = "out/extension.bundle.js";

try {
	const result = await build({
		entryPoints: [entry],
		outfile: bundled,
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node20",
		packages: "external",
		external: ["vscode"],
		// Readable stack traces in the logs: no minification, names kept.
		keepNames: true,
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
	});
	const modules = Object.keys(result.metafile.inputs).length;
	await rm(entry, { force: true });
	await rename(bundled, entry);
	const { size } = await stat(entry);
	console.log(`extension: bundled ${modules} modules into ${entry} (${Math.round(size / 1024)} KiB)`);
} catch (error) {
	await rm(bundled, { force: true });
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
