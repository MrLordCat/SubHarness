import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { ATTACHMENT_MAX_CHARS, attachmentLabel, IMAGE_ATTACHMENT_MAX_BYTES, looksBinary, type AttachmentContent } from "./attachments";
import type { ChatAttachmentsDeps } from "./chat-controller";
import { imageExtension, imageMimeType } from "./shared/attachment-label";
import { PASTED_FILE_MAX_BYTES, PASTED_FILES_LIMIT, type ChatAttachment, type ChatPastedFile } from "./shared/protocol";

/** Pasted files stay this long; a sent message keeps its images in the chat log. */
const PASTED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** A file name Windows and Linux accept; pasted screenshots get a dated one. */
export function pastedFileName(name: string, mimeType: string, now = new Date()): string {
	const safe = Array.from(name, character => character.charCodeAt(0) < 32 || "\\/:*?\"<>|".includes(character) ? "_" : character).join("");
	const cleaned = safe.replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 120);
	const extension = imageExtension(mimeType);
	if (cleaned && !(extension && /^image\.(png|jpe?g|gif|webp)$/i.test(cleaned))) {
		return cleaned;
	}
	const pad = (value: number): string => String(value).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `pasted-${stamp}.${extension ?? "bin"}`;
}

interface AttachmentPickItem extends vscode.QuickPickItem {
	attachment?: ChatAttachment;
	action?: "search" | "browse";
}

function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

function attachmentKey(attachment: ChatAttachment): string {
	return `${attachment.uri}:${attachment.startLine ?? ""}:${attachment.endLine ?? ""}`;
}

function dedupe(attachments: readonly ChatAttachment[]): ChatAttachment[] {
	const seen = new Set<string>();
	const result: ChatAttachment[] = [];
	for (const attachment of attachments) {
		const key = attachmentKey(attachment);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(attachment);
	}
	return result;
}

/** Feeds the chat window with editor selections and files. */
export class ChatAttachmentSource implements ChatAttachmentsDeps {
	private readonly _options: { log?: (event: string, data: Record<string, unknown>) => void; pasteDir?: vscode.Uri };

	/** pasteDir: where pasted screenshots and files are saved; without it pasting attaches nothing. */
	constructor(options: { log?: (event: string, data: Record<string, unknown>) => void; pasteDir?: vscode.Uri } = {}) {
		this._options = options;
	}

	/** Saves pasted bytes as files, one folder per file so names never clash, and attaches them. */
	async savePasted(files: readonly ChatPastedFile[]): Promise<ChatAttachment[]> {
		const root = this._options.pasteDir;
		if (!root) {
			return [];
		}
		await this._prunePasted(root);
		const attachments: ChatAttachment[] = [];
		for (const file of files.slice(0, PASTED_FILES_LIMIT)) {
			const data = Buffer.from(file.data, "base64");
			if (data.byteLength === 0 || data.byteLength > PASTED_FILE_MAX_BYTES) {
				continue;
			}
			const uri = vscode.Uri.joinPath(root, randomUUID(), pastedFileName(file.name, file.mimeType));
			try {
				await vscode.workspace.fs.writeFile(uri, data);
				attachments.push(this.file(uri));
			} catch (error) {
				this._options.log?.("chat.attachment.paste_failed", { message: errorText(error) });
			}
		}
		return attachments;
	}

	private async _prunePasted(root: vscode.Uri): Promise<void> {
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(root);
		} catch {
			return;
		}
		const cutoff = Date.now() - PASTED_RETENTION_MS;
		for (const [name, type] of entries) {
			if (!(type & vscode.FileType.Directory)) {
				continue;
			}
			const folder = vscode.Uri.joinPath(root, name);
			try {
				if ((await vscode.workspace.fs.stat(folder)).mtime < cutoff) {
					await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
				}
			} catch {
				// Another window may have removed it first.
			}
		}
	}

	selection(): ChatAttachment | undefined {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			return undefined;
		}
		const document = editor.document;
		const selection = editor.selection;
		const startLine = selection.start.line + 1;
		let endLine = selection.end.line + 1;
		if (selection.end.character === 0 && selection.end.line > selection.start.line) {
			endLine -= 1;
		}
		const text = document.getText(selection);
		return {
			id: randomUUID(),
			kind: "selection",
			path: this._path(document.uri),
			uri: document.uri.toString(),
			startLine,
			endLine,
			text: text.length > ATTACHMENT_MAX_CHARS ? text.slice(0, ATTACHMENT_MAX_CHARS) : text,
			languageId: document.languageId,
		};
	}

	file(uri: vscode.Uri): ChatAttachment {
		const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
		return {
			id: randomUUID(),
			kind: "file",
			path: this._path(uri),
			uri: uri.toString(),
			...(open ? { languageId: open.languageId } : {}),
		};
	}

	async fromUris(uris: readonly string[]): Promise<ChatAttachment[]> {
		const attachments: ChatAttachment[] = [];
		for (const raw of uris) {
			let uri: vscode.Uri;
			try {
				uri = vscode.Uri.parse(raw);
			} catch {
				continue;
			}
			if (uri.scheme !== "file" && uri.scheme !== "untitled") {
				continue;
			}
			if (uri.scheme === "file") {
				try {
					const stat = await vscode.workspace.fs.stat(uri);
					if (!(stat.type & vscode.FileType.File)) {
						continue;
					}
				} catch {
					continue;
				}
			}
			attachments.push(this.file(uri));
		}
		return dedupe(attachments);
	}

	async pick(): Promise<ChatAttachment[]> {
		const items: AttachmentPickItem[] = [];
		const selection = this.selection();
		if (selection) {
			items.push({ label: `Selection: ${attachmentLabel(selection)}`, description: selection.path, attachment: selection });
		}
		const active = vscode.window.activeTextEditor;
		if (active) {
			const uri = active.document.uri;
			items.push({ label: `Active file: ${this._name(uri)}`, description: this._path(uri), attachment: this.file(uri) });
		}
		const editors: AttachmentPickItem[] = [];
		const seen = new Set<string>();
		const activeUri = active?.document.uri.toString();
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (!(tab.input instanceof vscode.TabInputText)) {
					continue;
				}
				const uri = tab.input.uri;
				const key = uri.toString();
				if (key === activeUri || seen.has(key)) {
					continue;
				}
				seen.add(key);
				editors.push({ label: this._name(uri), description: this._path(uri), attachment: this.file(uri) });
			}
		}
		if (editors.length > 0) {
			items.push({ label: "Open editors", kind: vscode.QuickPickItemKind.Separator }, ...editors);
		}
		items.push({ label: "Search workspace files…", action: "search" }, { label: "Browse…", action: "browse" });

		const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, matchOnDescription: true, placeHolder: "Attach files and selections" });
		if (!chosen) {
			return [];
		}
		const picked = chosen.flatMap(item => item.attachment ? [item.attachment] : []);
		if (chosen.some(item => item.action === "search")) {
			picked.push(...await this._search());
		}
		if (chosen.some(item => item.action === "browse")) {
			picked.push(...await this._browse());
		}
		return dedupe(picked);
	}

	async read(attachments: readonly ChatAttachment[]): Promise<AttachmentContent[]> {
		const contents: AttachmentContent[] = [];
		for (const attachment of attachments) {
			contents.push(await this._read(attachment));
		}
		return contents;
	}

	async open(attachment: ChatAttachment): Promise<void> {
		const uri = vscode.Uri.parse(attachment.uri);
		const selection = attachment.kind === "selection" && attachment.startLine !== undefined && attachment.endLine !== undefined
			? new vscode.Range(attachment.startLine - 1, 0, attachment.endLine - 1, Number.MAX_SAFE_INTEGER)
			: undefined;
		if (!selection) {
			// vscode.open also shows images and other binary files in their editor.
			await vscode.commands.executeCommand("vscode.open", uri, { preview: true });
			return;
		}
		await vscode.window.showTextDocument(uri, { preview: true, selection });
	}

	private async _search(): Promise<ChatAttachment[]> {
		const uris = await vscode.workspace.findFiles("**/*", "{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}", 10_000);
		const items: AttachmentPickItem[] = uris.map(uri => ({ label: this._name(uri), description: this._path(uri), attachment: this.file(uri) }));
		const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, matchOnDescription: true, placeHolder: "Search workspace files" });
		return chosen?.flatMap(item => item.attachment ? [item.attachment] : []) ?? [];
	}

	private async _browse(): Promise<ChatAttachment[]> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			canSelectFiles: true,
			canSelectFolders: false,
			defaultUri: folder?.uri,
		});
		return uris ? this.fromUris(uris.map(uri => uri.toString())) : [];
	}

	private async _read(attachment: ChatAttachment): Promise<AttachmentContent> {
		if (attachment.kind === "selection") {
			return { attachment, text: attachment.text ?? "" };
		}
		try {
			const uri = vscode.Uri.parse(attachment.uri);
			const mimeType = imageMimeType(uri.path);
			if (mimeType) {
				const size = (await vscode.workspace.fs.stat(uri)).size;
				if (size > IMAGE_ATTACHMENT_MAX_BYTES) {
					return { attachment, error: "the image is larger than 3.75 MB" };
				}
				const data = await vscode.workspace.fs.readFile(uri);
				return { attachment, image: { mimeType, data: Buffer.from(data).toString("base64"), byteLength: data.byteLength, name: attachmentLabel(attachment) } };
			}
			const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === attachment.uri);
			if (open) {
				return { attachment, text: open.getText() };
			}
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > 2 * 1024 * 1024) {
				return { attachment, error: "the file is larger than 2 MB" };
			}
			const data = await vscode.workspace.fs.readFile(uri);
			if (looksBinary(data)) {
				return { attachment, error: "binary file" };
			}
			return { attachment, text: new TextDecoder().decode(data) };
		} catch (error) {
			this._options.log?.("chat.attachment.read_failed", { uri: attachment.uri, message: errorText(error) });
			return { attachment, error: errorText(error) };
		}
	}

	private _path(uri: vscode.Uri): string {
		const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
		return vscode.workspace.asRelativePath(uri, multiRoot).replace(/\\/g, "/");
	}

	private _name(uri: vscode.Uri): string {
		return uri.path.split("/").pop() || uri.path;
	}
}
