import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { lexer, type Token, type Tokens } from "marked";

const CACHE_LIMIT = 128;
const tokenCache = new Map<string, Token[]>();

/** Lexer output is cached, not VNodes: Preact VNodes are not reusable across positions. */
function lexMarkdown(text: string): Token[] {
	const cached = tokenCache.get(text);
	if (cached) {
		tokenCache.delete(text);
		tokenCache.set(text, cached);
		return cached;
	}
	let tokens: Token[];
	try {
		tokens = lexer(text);
	} catch {
		tokens = [{ type: "paragraph", raw: text, text, tokens: [{ type: "text", raw: text, text }] }];
	}
	tokenCache.set(text, tokens);
	if (tokenCache.size > CACHE_LIMIT) {
		const oldest = tokenCache.keys().next().value;
		if (oldest !== undefined) {
			tokenCache.delete(oldest);
		}
	}
	return tokens;
}

function safeHref(href: string | undefined): string | undefined {
	return href && /^https?:\/\//i.test(href) ? href : undefined;
}

export function Markdown({ text }: { text: string }) {
	return <div class="md">{renderBlocks(lexMarkdown(text))}</div>;
}

function renderBlocks(tokens: Token[]): ComponentChildren[] {
	return tokens.map((token, index) => renderBlockToken(token, index));
}

function renderBlockToken(token: Token, key: number): ComponentChildren {
	switch (token.type) {
		case "space":
		case "def":
			return null;
		case "heading": {
			const heading = token as Tokens.Heading;
			const depth = Math.min(6, Math.max(1, heading.depth));
			const Tag = `h${depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
			return <Tag key={key}>{renderInline(heading.tokens)}</Tag>;
		}
		case "paragraph":
			return <p key={key}>{renderInline((token as Tokens.Paragraph).tokens)}</p>;
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens ? renderInline(text.tokens) : <p key={key}>{text.text}</p>;
		}
		case "code": {
			const code = token as Tokens.Code;
			return <CodeBlock key={key} code={code.text} lang={code.lang} />;
		}
		case "blockquote":
			return <blockquote key={key}>{renderBlocks((token as Tokens.Blockquote).tokens)}</blockquote>;
		case "list": {
			const list = token as Tokens.List;
			const Tag = list.ordered ? "ol" : "ul";
			const start = list.ordered && typeof list.start === "number" ? list.start : undefined;
			return (
				<Tag key={key} start={start}>
					{list.items.map((item, index) => <li key={index}>{renderListItem(item)}</li>)}
				</Tag>
			);
		}
		case "table": {
			const table = token as Tokens.Table;
			return (
				<table key={key} class="md-table">
					<thead>
						<tr>
							{table.header.map((cell, index) => (
								<th key={index} style={{ textAlign: cell.align ?? undefined }}>{renderInline(cell.tokens)}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{table.rows.map((row, rowIndex) => (
							<tr key={rowIndex}>
								{row.map((cell, cellIndex) => (
									<td key={cellIndex} style={{ textAlign: cell.align ?? undefined }}>{renderInline(cell.tokens)}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			);
		}
		case "hr":
			return <hr key={key} />;
		case "html":
			return <div key={key} class="md-raw">{(token as Tokens.HTML).raw}</div>;
		default: {
			const generic = token as Tokens.Generic;
			if (Array.isArray(generic.tokens)) {
				return <Fragment key={key}>{renderBlocks(generic.tokens)}</Fragment>;
			}
			return typeof generic.text === "string" ? <p key={key}>{generic.text}</p> : null;
		}
	}
}

function renderListItem(item: Tokens.ListItem): ComponentChildren {
	const content = item.tokens ? renderBlocks(item.tokens) : item.text;
	if (!item.task) {
		return content;
	}
	return (
		<>
			<span class="md-task">{item.checked ? "[x]" : "[ ]"}</span> {content}
		</>
	);
}

function renderInline(tokens: Token[] | undefined): ComponentChildren[] {
	return tokens ? tokens.map((token, index) => renderInlineToken(token, index)) : [];
}

function renderInlineToken(token: Token, key: number): ComponentChildren {
	switch (token.type) {
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens ? <Fragment key={key}>{renderInline(text.tokens)}</Fragment> : text.text;
		}
		case "escape":
			return (token as Tokens.Escape).text;
		case "strong":
			return <strong key={key}>{renderInline((token as Tokens.Strong).tokens)}</strong>;
		case "em":
			return <em key={key}>{renderInline((token as Tokens.Em).tokens)}</em>;
		case "del":
			return <del key={key}>{renderInline((token as Tokens.Del).tokens)}</del>;
		case "codespan":
			return <code key={key} class="md-inline-code">{(token as Tokens.Codespan).text}</code>;
		case "br":
			return <br key={key} />;
		case "link": {
			const link = token as Tokens.Link;
			const href = safeHref(link.href);
			if (!href) {
				return <Fragment key={key}>{renderInline(link.tokens)}</Fragment>;
			}
			return (
				<a key={key} href={href} title={link.title ?? undefined} target="_blank" rel="noreferrer noopener">
					{renderInline(link.tokens)}
				</a>
			);
		}
		case "image":
			return <span key={key} class="md-image">{(token as Tokens.Image).text}</span>;
		case "html":
			return <span key={key} class="md-raw">{(token as Tokens.HTML).raw}</span>;
		case "checkbox": {
			const checkbox = token as Tokens.Checkbox;
			return <span key={key} class="md-task">{checkbox.checked ? "[x]" : "[ ]"}</span>;
		}
		default: {
			const generic = token as Tokens.Generic;
			if (Array.isArray(generic.tokens)) {
				return <Fragment key={key}>{renderInline(generic.tokens)}</Fragment>;
			}
			return typeof generic.text === "string" ? generic.text : generic.raw;
		}
	}
}

function CodeBlock({ code, lang }: { code: string; lang: string | undefined }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | undefined>(undefined);

	useEffect(() => () => {
		if (timer.current !== undefined) {
			clearTimeout(timer.current);
		}
	}, []);

	const copy = () => {
		const clipboard = navigator.clipboard;
		if (!clipboard) {
			return;
		}
		void clipboard.writeText(code).then(() => {
			setCopied(true);
			if (timer.current !== undefined) {
				clearTimeout(timer.current);
			}
			timer.current = window.setTimeout(() => setCopied(false), 1500);
		}, () => undefined);
	};

	return (
		<div class="md-code">
			<div class="md-code-head">
				<span class="md-code-lang">{lang || "code"}</span>
				<button type="button" class="md-copy" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
			</div>
			<pre><code>{code}</code></pre>
		</div>
	);
}
