// Screenshots of the bridge chat harness in headless Edge or Chrome, driven over the DevTools protocol.
// Build the harness first: node scripts/build-webview.mjs --harness
// Usage: node scripts/chat-harness-shots.mjs [--only=name,name] [--widths=320,420] [--out=artifacts/screens] [--browser=<msedge.exe>]
// Scenarios open the harness at any width (320 px too, which a real window cannot get below),
// run a few actions and save <out>/<name>.png. Runs without dialogs, so agents can use it unattended.
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
	const [key, ...rest] = arg.replace(/^--/, "").split("=");
	return [key, rest.join("=") || "true"];
}));
const outDir = path.resolve(args.out ?? "artifacts/screens");
const harnessDir = path.resolve("artifacts/chat-harness");
const harnessPage = path.join(harnessDir, "index.html");
const widths = args.widths ? args.widths.split(",").map(width => Number(width.trim())) : undefined;
if (widths?.some(width => !Number.isInteger(width) || width <= 0)) {
	console.error("--widths takes comma-separated pixel widths, e.g. --widths=320,420,1000.");
	process.exit(1);
}

/**
 * Actions: { wait: ms } | { click: selector } | { hover: selector } | { scrollTo: selector }
 * | { scrollTop: px } | { key: "Enter" | "Escape" | "Tab" | "ArrowUp" } | { type: text } | { focus: selector }.
 * A shot without an action list is taken right after the page settles.
 */
const SCENARIOS = [
	{ name: "subagents-panel-dark", width: 420, height: 900, params: { count: "8", subagents: "1" } },
	{ name: "subagents-panel-320", width: 320, height: 800, params: { count: "8", subagents: "1" } },
	{ name: "subagents-panel-light", width: 420, height: 900, params: { theme: "light", count: "8", subagents: "1" } },
	{ name: "light-errors", width: 420, height: 800, params: { theme: "light", count: "8" } },
	// The limit card is in the second message, so the top of the list shows it.
	{ name: "light-cards", width: 420, height: 900, params: { theme: "light", count: "40" }, actions: [{ scrollTop: 0 }] },
	{ name: "dark-cards-limit", width: 420, height: 900, params: { count: "40" }, actions: [{ scrollTop: 0 }] },
	{ name: "limit-auto-dark", width: 420, height: 900, params: { count: "40", limitLast: "1" }, actions: [{ scrollTop: 100000 }] },
	{ name: "limit-auto-off", width: 420, height: 900, params: { count: "40", limitLast: "1" }, actions: [{ scrollTop: 100000 }, { click: ".limit-auto input" }, { wait: 300 }] },
	{ name: "dark-cards-compaction", width: 420, height: 900, params: { count: "40" }, actions: [{ scrollTo: ".compaction-card" }] },
	{ name: "dark-cards-subagent", width: 420, height: 900, params: { count: "40" }, actions: [{ scrollTo: ".subagent-card" }] },
	{ name: "editor-wide-dark", width: 1500, height: 900, params: { host: "editor", count: "8" } },
	{ name: "editor-wide-light", width: 1500, height: 900, params: { host: "editor", theme: "light", count: "8" } },
	{ name: "sidebar-320", width: 320, height: 800, params: { count: "8" } },
	{ name: "sidebar-320-models", width: 320, height: 800, params: { count: "8" }, actions: [{ click: ".composer .picker-trigger" }] },
	{ name: "sidebar-320-history", width: 320, height: 800, params: { count: "8" }, actions: [{ click: ".history-trigger" }] },
	{ name: "sidebar-320-changes", width: 320, height: 800, params: { count: "8" }, actions: [{ click: ".changes-panel summary, .changes-toggle" }] },
	// A message with "danger" makes the fake host hold a call; Always allow then lists its kind in the Tools picker.
	{ name: "approval-always-allow", width: 420, height: 900, params: { count: "2" }, actions: [{ focus: ".composer textarea" }, { type: "run the danger command" }, { key: "Enter" }, { wait: 500 }, { scrollTo: ".approval-card" }] },
	{ name: "tools-always-allowed", width: 420, height: 900, params: { count: "2" }, actions: [{ focus: ".composer textarea" }, { type: "run the danger command" }, { key: "Enter" }, { wait: 500 }, { click: ".approval-always" }, { wait: 400 }, { click: ".tool-picker .picker-trigger" }, { wait: 300 }, { type: "always" }, { wait: 300 }] },
];

function findBrowser() {
	if (args.browser) {
		return args.browser;
	}
	const candidates = process.platform === "win32"
		? [
			path.join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft/Edge/Application/msedge.exe"),
			path.join(process.env.ProgramFiles ?? "", "Microsoft/Edge/Application/msedge.exe"),
			path.join(process.env.ProgramFiles ?? "", "Google/Chrome/Application/chrome.exe"),
		]
		: ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
	const found = candidates.find(candidate => existsSync(candidate));
	if (!found) {
		throw new Error("No Edge or Chrome found; pass --browser=<path>.");
	}
	return found;
}

const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

/** Serves artifacts/chat-harness/ on a random 127.0.0.1 port; HTTP avoids the file:// limits of browsers. */
function startServer() {
	const server = createServer((request, response) => {
		let pathname;
		try {
			pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
		} catch {
			response.writeHead(400).end("Bad request");
			return;
		}
		const file = path.resolve(harnessDir, `.${pathname}`);
		if (!file.startsWith(harnessDir + path.sep)) {
			response.writeHead(403).end("Forbidden");
			return;
		}
		let body;
		try {
			body = readFileSync(file);
		} catch {
			response.writeHead(404).end("Not found");
			return;
		}
		const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
		response.writeHead(200, { "Content-Type": type });
		response.end(body);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

async function connect(port) {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			const list = await (await globalThis.fetch(`http://127.0.0.1:${port}/json/list`)).json();
			const page = list.find(entry => entry.type === "page");
			if (page) {
				return page.webSocketDebuggerUrl;
			}
		} catch {
			// The browser is still starting.
		}
		await sleep(200);
	}
	throw new Error("The browser did not open a DevTools endpoint.");
}

class Page {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 0;
		this.pending = new Map();
		socket.addEventListener("message", event => {
			const message = JSON.parse(event.data);
			const waiter = message.id ? this.pending.get(message.id) : undefined;
			if (waiter) {
				this.pending.delete(message.id);
				if (message.error) {
					waiter.reject(new Error(message.error.message));
				} else {
					waiter.resolve(message.result);
				}
			}
		});
	}

	send(method, params = {}) {
		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	async evaluate(expression) {
		const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
		}
		return result.result.value;
	}

	async center(selector) {
		const point = await this.evaluate(`(() => {
			const node = document.querySelector(${JSON.stringify(selector)});
			const box = node?.getBoundingClientRect();
			return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
		})()`);
		if (!point) {
			throw new Error(`No element matches ${selector}`);
		}
		return point;
	}

	async key(key) {
		const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowUp: 38, ArrowDown: 40 };
		for (const type of ["keyDown", "keyUp"]) {
			await this.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: codes[key] ?? 0 });
		}
	}

	async run(action) {
		if (action.wait) {
			await sleep(action.wait);
		} else if (action.click) {
			const { x, y } = await this.center(action.click);
			for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
				await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
			}
		} else if (action.hover) {
			const { x, y } = await this.center(action.hover);
			await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		} else if (action.scrollTo) {
			// The list is virtual: only rows near the viewport exist, so page down from the top until the target renders.
			await this.evaluate(`(async () => {
				const selector = ${JSON.stringify(action.scrollTo)};
				const scroller = document.querySelector(".message-scroller");
				const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
				const move = top => {
					scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
					scroller.scrollTop = top;
					scroller.dispatchEvent(new Event("scroll"));
				};
				move(0);
				await frame();
				for (let step = 0; step < 200 && !document.querySelector(selector); step++) {
					move(scroller.scrollTop + scroller.clientHeight * 0.8);
					await frame();
				}
				const node = document.querySelector(selector);
				if (!node) { throw new Error("nothing to scroll to: " + selector); }
				move(scroller.scrollTop + node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40);
				await frame();
			})()`);
		} else if (action.scrollTop !== undefined) {
			await this.evaluate(`(() => {
				const scroller = document.querySelector(".message-scroller");
				scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
				scroller.scrollTop = ${Number(action.scrollTop)};
				scroller.dispatchEvent(new Event("scroll"));
			})()`);
		} else if (action.key) {
			await this.key(action.key);
		} else if (action.focus) {
			await this.evaluate(`document.querySelector(${JSON.stringify(action.focus)})?.focus()`);
		} else if (action.type !== undefined) {
			await this.send("Input.insertText", { text: action.type });
		}
		await sleep(250);
	}
}

if (!existsSync(harnessPage)) {
	console.error(`No harness at ${harnessPage}.`);
	console.error("Build it first: node scripts/build-webview.mjs --harness");
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const only = args.only ? new Set(args.only.split(",")) : undefined;
const scenarios = SCENARIOS.filter(scenario => !only || only.has(scenario.name));
const shots = scenarios.flatMap(scenario => (widths ?? [scenario.width]).map(width => ({ scenario, width })));
const port = 9300 + Math.floor(Math.random() * 500);
let server;
let profile;
let browser;
let socket;
let failed = 0;
try {
	server = await startServer();
	const harnessUrl = new URL(`http://127.0.0.1:${server.address().port}/index.html`);
	profile = mkdtempSync(path.join(tmpdir(), "chat-harness-shots-"));
	browser = spawn(findBrowser(), [
		"--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
		"--no-first-run", "--disable-gpu", "about:blank",
	], { stdio: "ignore" });
	socket = new globalThis.WebSocket(await connect(port));
	await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
	const page = new Page(socket);
	await page.send("Page.enable");
	for (const { scenario, width } of shots) {
		const name = widths ? `${scenario.name}-${width}` : scenario.name;
		try {
			await page.send("Emulation.setDeviceMetricsOverride", { width, height: scenario.height, deviceScaleFactor: 1, mobile: false });
			const url = new URL(harnessUrl);
			for (const [key, value] of Object.entries(scenario.params ?? {})) {
				url.searchParams.set(key, value);
			}
			await page.send("Page.navigate", { url: url.href });
			await sleep(1200);
			for (const action of scenario.actions ?? []) {
				await page.run(action);
			}
			await sleep(300);
			const { data } = await page.send("Page.captureScreenshot", { format: "png" });
			const file = path.join(outDir, `${name}.png`);
			writeFileSync(file, Buffer.from(data, "base64"));
			console.log(`ok   ${name} -> ${path.relative(process.cwd(), file)}`);
		} catch (error) {
			failed++;
			console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
} finally {
	socket?.close();
	browser?.kill();
	server?.close();
	server?.closeAllConnections?.();
	await sleep(500);
	if (profile) {
		rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
}
process.exitCode = failed > 0 ? 1 : 0;
