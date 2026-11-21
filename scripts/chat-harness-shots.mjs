// Screenshots of the bridge chat harness in headless Edge or Chrome, driven over the DevTools protocol.
// Build the harness first: node scripts/build-webview.mjs --harness
// Usage: node scripts/chat-harness-shots.mjs [--only=name,name] [--out=artifacts/screens] [--browser=<msedge.exe>]
// Scenarios open the harness at any width (320 px too, which a real window cannot get below),
// run a few actions and save <out>/<name>.png. Runs without dialogs, so agents can use it unattended.
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
	const [key, ...rest] = arg.replace(/^--/, "").split("=");
	return [key, rest.join("=") || "true"];
}));
const outDir = path.resolve(args.out ?? "artifacts/screens");
const harnessPage = path.resolve("artifacts/chat-harness/index.html");

/**
 * Actions: { wait: ms } | { click: selector } | { hover: selector } | { scrollTo: selector }
 * | { scrollTop: px } | { key: "Enter" | "Escape" | "Tab" | "ArrowUp" } | { type: text } | { focus: selector }.
 * A shot without an action list is taken right after the page settles.
 */
const SCENARIOS = [
	{ name: "light-errors", width: 420, height: 800, params: { theme: "light", count: "8" } },
	// The limit card is in the second message, so the top of the list shows it.
	{ name: "light-cards", width: 420, height: 900, params: { theme: "light", count: "40" }, actions: [{ scrollTop: 0 }] },
	{ name: "dark-cards-limit", width: 420, height: 900, params: { count: "40" }, actions: [{ scrollTop: 0 }] },
	{ name: "dark-cards-compaction", width: 420, height: 900, params: { count: "40" }, actions: [{ scrollTo: ".compaction-card" }] },
	{ name: "dark-cards-subagent", width: 420, height: 900, params: { count: "40" }, actions: [{ scrollTo: ".subagent-card" }] },
	{ name: "editor-wide-dark", width: 1500, height: 900, params: { host: "editor", count: "8" } },
	{ name: "editor-wide-light", width: 1500, height: 900, params: { host: "editor", theme: "light", count: "8" } },
	{ name: "sidebar-320", width: 320, height: 800, params: { count: "8" } },
	{ name: "sidebar-320-models", width: 320, height: 800, params: { count: "8" }, actions: [{ click: ".composer .picker-trigger" }] },
	{ name: "sidebar-320-history", width: 320, height: 800, params: { count: "8" }, actions: [{ click: ".history-trigger" }] },
	{ name: "sidebar-320-changes", width: 320, height: 800, params: { count: "8" }, actions: [{ click: ".changes-panel summary, .changes-toggle" }] },
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
	throw new Error(`No harness at ${harnessPage}; run node scripts/build-webview.mjs --harness first.`);
}
mkdirSync(outDir, { recursive: true });
const only = args.only ? new Set(args.only.split(",")) : undefined;
const scenarios = SCENARIOS.filter(scenario => !only || only.has(scenario.name));
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(path.join(tmpdir(), "chat-harness-shots-"));
const browser = spawn(findBrowser(), [
	"--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--disable-gpu", "--allow-file-access-from-files", "about:blank",
], { stdio: "ignore" });
const socket = new globalThis.WebSocket(await connect(port));
await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
const page = new Page(socket);
let failed = 0;
try {
	await page.send("Page.enable");
	for (const scenario of scenarios) {
		try {
			await page.send("Emulation.setDeviceMetricsOverride", { width: scenario.width, height: scenario.height, deviceScaleFactor: 1, mobile: false });
			const url = new URL(pathToFileURL(harnessPage));
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
			const file = path.join(outDir, `${scenario.name}.png`);
			writeFileSync(file, Buffer.from(data, "base64"));
			console.log(`ok   ${scenario.name} -> ${path.relative(process.cwd(), file)}`);
		} catch (error) {
			failed++;
			console.log(`FAIL ${scenario.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
} finally {
	socket.close();
	browser.kill();
	await sleep(500);
	rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exitCode = failed > 0 ? 1 : 0;
