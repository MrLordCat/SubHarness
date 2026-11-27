import * as assert from "node:assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as vscode from "vscode";
import type { ChatTool } from "../chat/tools/types";
import { createWebTools, htmlToText } from "../chat/tools/web-tools";

suite("Chat web tools", () => {
	let server: http.Server;
	let origin: string;
	const tokens: vscode.CancellationTokenSource[] = [];

	suiteSetup(async () => {
		server = http.createServer((request, response) => {
			const path = request.url ?? "/";
			if (path === "/page") {
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				response.end("<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>World <a href=\"https://example.com\">Example</a></p></body></html>");
				return;
			}
			if (path === "/json") {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end("{\"ok\":true}");
				return;
			}
			if (path === "/binary") {
				response.writeHead(200, { "Content-Type": "image/png" });
				response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
				return;
			}
			if (path === "/large") {
				response.writeHead(200, { "Content-Type": "text/plain" });
				response.end("a".repeat(3_000_000));
				return;
			}
			if (path === "/long") {
				response.writeHead(200, { "Content-Type": "text/plain" });
				response.end([
					"First paragraph intro.",
					"filler ".repeat(7000),
					"The needle is in this paragraph.",
					"unrelated tail ".repeat(3000),
				].join("\n\n"));
				return;
			}
			response.writeHead(404, { "Content-Type": "text/plain" });
			response.end("missing");
		});
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	suiteTeardown(async () => {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	});

	teardown(() => {
		for (const token of tokens.splice(0)) {
			token.dispose();
		}
	});

	function tool(): ChatTool {
		return createWebTools()[0];
	}

	async function invoke(input: unknown): Promise<string> {
		const source = new vscode.CancellationTokenSource();
		tokens.push(source);
		const result = await tool().invoke(input, source.token);
		return typeof result === "string" ? result : result.text;
	}

	test("htmlToText keeps the title and headings", () => {
		assert.strictEqual(
			htmlToText("<html><head><title>My &amp; Page</title><meta charset=\"utf-8\"></head><body><h1>Top</h1><h2>Sub</h2></body></html>"),
			"# My & Page\n# Top\n## Sub"
		);
	});

	test("htmlToText turns list items into lines", () => {
		assert.strictEqual(htmlToText("<ul><li>one</li><li>two</li></ul>"), "- one\n- two");
	});

	test("htmlToText appends absolute links and leaves relative ones alone", () => {
		assert.strictEqual(
			htmlToText("<p><a href=\"https://example.com\">Example</a> and <a href='/relative'>Relative</a> and <a href=\"https://same.test\">https://same.test</a></p>"),
			"Example (https://example.com) and Relative and https://same.test"
		);
	});

	test("htmlToText decodes known and numeric entities", () => {
		assert.strictEqual(
			htmlToText("<p>&amp; &lt; &gt; &quot; &#39; &apos; &nbsp; &#65; &#x42; &unknown;</p>"),
			"& < > \" ' ' A B &unknown;"
		);
	});

	test("htmlToText drops scripts, styles and head content", () => {
		assert.strictEqual(
			htmlToText("<style>body { color: red; }</style><script>var x = \"<p>\";</script><noscript>off</noscript><p>Keep</p>"),
			"Keep"
		);
	});

	test("htmlToText separates table cells and rows", () => {
		assert.strictEqual(
			htmlToText("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"),
			"a | b\nc | d"
		);
	});

	test("htmlToText collapses whitespace and shows image alt text", () => {
		assert.strictEqual(htmlToText("<p>  lots   of\t space  </p><img alt=\"A cat\">"), "lots of space\n[image: A cat]");
	});

	test("htmlToText finishes quickly on large malformed input", () => {
		const malformed = `${"<div><script>".repeat(60000)}${"<a href='x'>".repeat(20000)}`;
		const started = Date.now();
		const text = htmlToText(malformed);
		const elapsed = Date.now() - started;
		assert.strictEqual(typeof text, "string");
		assert.ok(elapsed < 5000, `htmlToText took ${elapsed} ms`);
	});

	test("fetch_webpage returns a converted HTML page", async () => {
		const result = await invoke({ urls: [`${origin}/page`] });
		assert.ok(result.startsWith(`## ${origin}/page\n# Test Page\n# Hello\n`));
		assert.match(result, /World Example \(https:\/\/example\.com\)/);
	});

	test("fetch_webpage returns JSON unchanged", async () => {
		assert.strictEqual(await invoke({ urls: [`${origin}/json`] }), `## ${origin}/json\n{"ok":true}`);
	});

	test("fetch_webpage reports a failed URL inside a mixed result", async () => {
		const result = await invoke({ urls: [`${origin}/page`, `${origin}/missing`] });
		assert.ok(result.startsWith(`## ${origin}/page\n`));
		assert.ok(result.includes(`## ${origin}/missing\nError: HTTP 404 Not Found`));
	});

	test("fetch_webpage throws when every URL fails", async () => {
		await assert.rejects(invoke({ urls: [`${origin}/missing`] }), /Error: HTTP 404 Not Found/);
	});

	test("fetch_webpage rejects non-http schemes and unsupported content types", async () => {
		await assert.rejects(invoke({ urls: ["ftp://example.com/file"] }), /Only http and https URLs are supported\./);
		await assert.rejects(invoke({ urls: [`${origin}/binary`] }), /Unsupported content type image\/png\. fetch_webpage reads HTML, plain text, JSON and XML/);
		await assert.rejects(invoke({ urls: ["://bad"] }), /Invalid URL: :\/\/bad/);
	});

	test("fetch_webpage cuts the body at 2 MB and says so", async () => {
		const result = await invoke({ urls: [`${origin}/large`] });
		assert.match(result, /\(40000 of 2000000 characters shown\)/);
		assert.ok(result.endsWith("(the page was cut at 2 MB)"));
	});

	test("fetch_webpage keeps the paragraphs a query matches", async () => {
		const result = await invoke({ urls: [`${origin}/long`], query: "needle" });
		assert.ok(result.includes("First paragraph intro."));
		assert.ok(result.includes("The needle is in this paragraph."));
		assert.ok(result.includes("…"), "skipped paragraphs must be marked");
		assert.ok(!result.includes("unrelated tail"), "unrelated paragraphs beyond the limit must be dropped");
		assert.match(result, /\(\d+ of \d+ characters shown\)/);
	});
});
