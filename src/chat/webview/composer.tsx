import type { ComponentChildren, TargetedDragEvent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { attachmentLabel, attachmentTitle, imageMimeType } from "../shared/attachment-label";
import {
	PASTED_FILE_MAX_BYTES,
	PASTED_FILES_LIMIT,
	type ChatAttachment,
	type ChatContextSettings,
	type ChatModelGroup,
	type ChatPastedFile,
	type ChatProviderQuota,
	type ChatRunState,
	type ChatSignInOffer,
	type ChatToolGroup,
} from "../shared/protocol";
import { ContextIndicator } from "./context-popup";
import { formatQuotaExhausted, parseUriList, type CacheHitLabel } from "./format";
import { ModelPicker } from "./model-picker";
import { QuotaIndicator } from "./quota-indicator";
import { ThinkingPicker } from "./thinking-picker";
import { ToolPicker } from "./tool-picker";

interface ComposerProps {
	run: ChatRunState;
	models: ChatModelGroup[];
	tools: ChatToolGroup[];
	selectedModelId: string | undefined;
	selectedThinking: string | undefined;
	quota: ChatProviderQuota[];
	context: string | undefined;
	contextTitle?: string;
	/** The sliders the context indicator opens; without them it is plain text. */
	contextSettings?: ChatContextSettings;
	cache?: CacheHitLabel;
	attachments: ChatAttachment[];
	/** Text the textarea starts with; later changes come from typing. */
	initialText?: string;
	/** Accessible name for the message textarea. */
	ariaLabel?: string;
	/** Focus the textarea on mount and put the caret at the end. */
	autoFocus?: boolean;
	/** Text the composer takes over when seq changes, e.g. what Stop took back from the queue. */
	draft?: { text: string; seq: number };
	/** Called with the text after every change, e.g. to keep it as the chat's draft. */
	onTextChange?: (text: string) => void;
	/** When given, Escape cancels, a Cancel button appears and Stop is never shown. */
	onCancel?: () => void;
	onEditLast?: () => void;
	/** Rendered below the input row, e.g. the edit hint. */
	footer?: ComponentChildren;
	placeholder?: string;
	/** Extra class on the root, e.g. "composer-edit". */
	class?: string;
	onSend: (text: string) => void;
	onStop: () => void;
	onSelectModel: (modelId: string) => void;
	/** Starred models; the picker opens on them. */
	favoriteModels?: string[];
	onSetFavoriteModel?: (modelId: string, favorite: boolean) => void;
	onSelectThinking: (value: string) => void;
	onRefreshQuota: () => void;
	onSetToolsEnabled: (names: string[], enabled: boolean) => void;
	onPickAttachments: () => void;
	onAddAttachments: (uris: string[]) => void;
	/** Screenshots and files pasted or dropped from outside VS Code. */
	onPasteFiles?: (files: ChatPastedFile[]) => void;
	signIn?: ChatSignInOffer[];
	onSignIn?: (provider: string) => void;
	onOpenAttachment: (attachment: ChatAttachment) => void;
	onRemoveAttachment: (id: string) => void;
}

function carriesAttachments(transfer: DataTransfer | null): boolean {
	if (!transfer) {
		return false;
	}
	const types = Array.from(transfer.types);
	return types.includes("application/vnd.code.uri-list") || types.includes("text/uri-list") || types.includes("Files");
}

/** file: and untitled: entries of a uri list; a copied web link stays text. */
function fileUris(transfer: DataTransfer): string[] {
	const payload = transfer.getData("application/vnd.code.uri-list") || transfer.getData("text/uri-list");
	return parseUriList(payload).filter(uri => /^(file|untitled):/i.test(uri));
}

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

/** The webview gets pasted files without a path, so their bytes go to the host. */
async function readPastedFiles(files: readonly File[]): Promise<{ read: ChatPastedFile[]; skipped: string[] }> {
	const read: ChatPastedFile[] = [];
	const skipped: string[] = [];
	for (const file of files.slice(0, PASTED_FILES_LIMIT)) {
		const name = file.name || "file";
		if (file.size === 0 || file.size > PASTED_FILE_MAX_BYTES) {
			skipped.push(name);
			continue;
		}
		try {
			read.push({ name: file.name, mimeType: file.type, data: toBase64(await file.arrayBuffer()) });
		} catch {
			// A pasted folder has no readable bytes.
			skipped.push(name);
		}
	}
	if (files.length > PASTED_FILES_LIMIT) {
		skipped.push(`${files.length - PASTED_FILES_LIMIT} more`);
	}
	return { read, skipped };
}

function attachmentIcon(attachment: ChatAttachment): string {
	if (attachment.kind === "selection") {
		return "✂";
	}
	return imageMimeType(attachment.path) ? "🖼" : "📄";
}

export function Composer({
	run,
	models,
	tools,
	selectedModelId,
	selectedThinking,
	quota,
	cache,
	context,
	contextTitle,
	contextSettings,
	attachments,
	initialText,
	ariaLabel,
	autoFocus,
	draft,
	onTextChange,
	onCancel,
	onEditLast,
	footer,
	placeholder,
	class: extraClass,
	onSend,
	onStop,
	onSelectModel,
	favoriteModels,
	onSetFavoriteModel,
	onSelectThinking,
	onRefreshQuota,
	onSetToolsEnabled,
	onPickAttachments,
	onAddAttachments,
	onPasteFiles,
	signIn,
	onSignIn,
	onOpenAttachment,
	onRemoveAttachment,
}: ComposerProps) {
	const [text, setText] = useState(initialText ?? "");
	const [dragOver, setDragOver] = useState(false);
	const [pasteNote, setPasteNote] = useState<string | undefined>(undefined);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const focusDraft = useRef(false);
	const draftSeq = draft?.seq;
	// A draft that arrived before this composer mounted was already taken over by another one.
	const appliedDraftSeq = useRef(draftSeq);

	useEffect(() => {
		if (!autoFocus) {
			return;
		}
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	}, [autoFocus]);

	useEffect(() => {
		if (draftSeq === undefined || draftSeq === appliedDraftSeq.current) {
			return;
		}
		appliedDraftSeq.current = draftSeq;
		const next = [draft?.text ?? "", text].filter(part => part.trim()).join("\n\n");
		if (next === text) {
			const textarea = textareaRef.current;
			if (textarea) {
				textarea.focus();
				textarea.setSelectionRange(textarea.value.length, textarea.value.length);
			}
			return;
		}
		focusDraft.current = true;
		setText(next);
	}, [draftSeq]);

	useEffect(() => {
		if (!focusDraft.current) {
			return;
		}
		focusDraft.current = false;
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	}, [text]);

	useEffect(() => {
		onTextChange?.(text);
	}, [text]);

	useEffect(() => {
		if (!pasteNote) {
			return;
		}
		const timer = setTimeout(() => setPasteNote(undefined), 6_000);
		return () => clearTimeout(timer);
	}, [pasteNote]);

	const attachFiles = (files: File[]) => {
		if (!onPasteFiles) {
			return;
		}
		void readPastedFiles(files).then(({ read, skipped }) => {
			if (read.length > 0) {
				onPasteFiles(read);
			}
			if (skipped.length > 0) {
				setPasteNote(`Not attached: ${skipped.join(", ")} (empty, a folder or over 20 MB).`);
			}
		});
	};

	const onPaste = (event: ClipboardEvent) => {
		const transfer = event.clipboardData;
		if (!transfer) {
			return;
		}
		const uris = fileUris(transfer);
		if (uris.length > 0) {
			event.preventDefault();
			onAddAttachments(uris);
			return;
		}
		const files = Array.from(transfer.files);
		// Text that comes with a picture of itself (a spreadsheet range, a web page) pastes as text.
		if (files.length === 0 || !onPasteFiles || transfer.getData("text/plain")) {
			return;
		}
		event.preventDefault();
		attachFiles(files);
	};

	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.style.height = "auto";
		const limit = Math.max(80, Math.round(document.documentElement.clientHeight * 0.4));
		// border-box height also covers the borders, which scrollHeight leaves out.
		textarea.style.height = `${Math.min(textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight, limit)}px`;
	}, [text]);

	const canSend = text.trim().length > 0 && (!run.running || !onCancel);
	const selectedGroup = models.find(group => group.models.some(model => model.id === selectedModelId));
	const selectedModel = selectedGroup?.models.find(model => model.id === selectedModelId);
	const selectedQuota = selectedGroup === undefined ? undefined : quota.find(entry => entry.provider === selectedGroup.provider);
	const quotaWarning = onCancel === undefined && selectedQuota ? formatQuotaExhausted(selectedQuota, Date.now()) : undefined;
	const submit = () => {
		if (!canSend) {
			return;
		}
		onSend(text);
		setText("");
	};
	const sendButton = (
		<button
			type="button"
			class="send-button"
			aria-label="Send"
			title={run.running ? "Send (Enter); the agent reads it after the current tool call" : "Send (Enter)"}
			disabled={!canSend}
			onClick={submit}
		>
			<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
				<path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
		</button>
	);

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape" && onCancel) {
			event.preventDefault();
			onCancel();
			return;
		}
		if (event.key === "ArrowUp" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !text.trim() && attachments.length === 0 && !run.running && !onCancel) {
			event.preventDefault();
			onEditLast?.();
			return;
		}
		if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
			return;
		}
		if (run.running && onCancel) {
			return;
		}
		event.preventDefault();
		submit();
	};

	const onDragEnter = (event: TargetedDragEvent<HTMLDivElement>) => {
		if (!carriesAttachments(event.dataTransfer)) {
			return;
		}
		event.preventDefault();
		setDragOver(true);
	};

	const onDragOver = (event: TargetedDragEvent<HTMLDivElement>) => {
		if (!carriesAttachments(event.dataTransfer)) {
			return;
		}
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = "copy";
		}
		setDragOver(true);
	};

	const onDragLeave = (event: TargetedDragEvent<HTMLDivElement>) => {
		if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
			setDragOver(false);
		}
	};

	const onDrop = (event: TargetedDragEvent<HTMLDivElement>) => {
		event.preventDefault();
		setDragOver(false);
		const transfer = event.dataTransfer;
		if (!transfer) {
			return;
		}
		const uris = fileUris(transfer);
		if (uris.length > 0) {
			onAddAttachments(uris);
			return;
		}
		// Files dragged from the system file manager carry no VS Code uri list.
		const files = Array.from(transfer.files);
		if (files.length > 0) {
			attachFiles(files);
		}
	};

	return (
		<div
			class={`composer${extraClass ? ` ${extraClass}` : ""}${dragOver ? " composer-dragover" : ""}`}
			onDragEnter={onDragEnter}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			{quotaWarning ? <div class="quota-warning-line" role="status">{quotaWarning} Pick another model or wait.</div> : null}
			{pasteNote ? <div class="quota-warning-line" role="status">{pasteNote}</div> : null}
			<div class="composer-box">
				{attachments.length > 0 ? (
					<div class="attachment-chips">
						{attachments.map(attachment => (
							<span class="attachment-chip" key={attachment.id}>
								<button
									type="button"
									class="attachment-chip-open"
									title={attachmentTitle(attachment)}
									onClick={() => onOpenAttachment(attachment)}
								>
									{attachmentIcon(attachment)}
									<span class="attachment-chip-label">{attachmentLabel(attachment)}</span>
								</button>
								<button
									type="button"
									class="attachment-chip-remove"
									aria-label={`Remove ${attachmentLabel(attachment)}`}
									title="Remove"
									onClick={() => onRemoveAttachment(attachment.id)}
								>
									×
								</button>
							</span>
						))}
					</div>
				) : null}
				<textarea
					ref={textareaRef}
					class="composer-input"
					aria-label={ariaLabel ?? "Message"}
					rows={1}
					placeholder={placeholder ?? (run.running && !onCancel ? "Add a message for the running agent…" : "Ask anything…")}
					value={text}
					onInput={event => setText(event.currentTarget.value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
				/>
				<div class="composer-row">
					<div class="composer-tools">
						<button
							type="button"
							class="attach-button"
							aria-label="Add context"
							title="Attach files or the editor selection; Shift+drag files here to attach them"
							onClick={onPickAttachments}
						>
							<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
								<path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
							</svg>
						</button>
						<ModelPicker
							models={models}
							selectedModelId={selectedModelId}
							quota={quota}
							onRefreshQuota={onRefreshQuota}
							onSelectModel={onSelectModel}
							favorites={favoriteModels}
							onSetFavorite={onSetFavoriteModel}
							signIn={signIn}
							onSignIn={onSignIn}
						/>
						{selectedModel?.thinking
							? <ThinkingPicker thinking={selectedModel.thinking} selected={selectedThinking} onSelect={onSelectThinking} />
							: null}
						<ToolPicker tools={tools} onSetToolsEnabled={onSetToolsEnabled} />
					</div>
					{/* Status and buttons wrap together: on a second line the status starts left and the buttons stay right. */}
					<div class="composer-actions">
						<div class="composer-status">
							<QuotaIndicator quota={quota} provider={selectedGroup?.provider} onRefresh={onRefreshQuota} />
							{cache ? <span class={`cache-indicator cache-${cache.level}`} title={cache.title}>{cache.text}</span> : null}
							<ContextIndicator context={context} title={contextTitle} settings={contextSettings} />
						</div>
						<div class="composer-buttons">
							{run.running && !run.stopping && !onCancel ? (
								<button type="button" class="send-button send-button-stop" aria-label="Stop" title="Stop" onClick={onStop}>
									<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
										<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
									</svg>
								</button>
							) : null}
							{onCancel ? <button type="button" class="composer-cancel" onClick={onCancel}>Cancel</button> : null}
							{sendButton}
						</div>
					</div>
				</div>
			</div>
			{footer}
		</div>
	);
}
