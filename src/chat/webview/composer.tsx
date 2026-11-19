import type { ComponentChildren, TargetedDragEvent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { attachmentLabel, attachmentTitle } from "../shared/attachment-label";
import type { ChatAttachment, ChatModelGroup, ChatProviderQuota, ChatRunState, ChatToolGroup } from "../shared/protocol";
import { parseUriList, type CacheHitLabel } from "./format";
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
	cache?: CacheHitLabel;
	attachments: ChatAttachment[];
	/** Text the textarea starts with; later changes come from typing. */
	initialText?: string;
	/** Focus the textarea on mount and put the caret at the end. */
	autoFocus?: boolean;
	/** Text the composer takes over when seq changes, e.g. what Stop took back from the queue. */
	draft?: { text: string; seq: number };
	/** When given, Escape cancels, a Cancel button appears and Stop is never shown. */
	onCancel?: () => void;
	/** Rendered below the input row, e.g. the edit hint. */
	footer?: ComponentChildren;
	placeholder?: string;
	/** Extra class on the root, e.g. "composer-edit". */
	class?: string;
	onSend: (text: string) => void;
	onStop: () => void;
	onSelectModel: (modelId: string) => void;
	onSelectThinking: (value: string) => void;
	onRefreshQuota: () => void;
	onSetToolsEnabled: (names: string[], enabled: boolean) => void;
	onPickAttachments: () => void;
	onAddAttachments: (uris: string[]) => void;
	onOpenAttachment: (attachment: ChatAttachment) => void;
	onRemoveAttachment: (id: string) => void;
}

function carriesAttachments(transfer: DataTransfer | null): boolean {
	if (!transfer) {
		return false;
	}
	const types = Array.from(transfer.types);
	return types.includes("application/vnd.code.uri-list") || types.includes("text/uri-list");
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
	attachments,
	initialText,
	autoFocus,
	draft,
	onCancel,
	footer,
	placeholder,
	class: extraClass,
	onSend,
	onStop,
	onSelectModel,
	onSelectThinking,
	onRefreshQuota,
	onSetToolsEnabled,
	onPickAttachments,
	onAddAttachments,
	onOpenAttachment,
	onRemoveAttachment,
}: ComposerProps) {
	const [text, setText] = useState(initialText ?? "");
	const [dragOver, setDragOver] = useState(false);
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
		const payload = transfer.getData("application/vnd.code.uri-list") || transfer.getData("text/uri-list");
		const uris = parseUriList(payload);
		if (uris.length > 0) {
			onAddAttachments(uris);
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
									{attachment.kind === "selection" ? "✂" : "📄"}
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
					rows={1}
					placeholder={placeholder ?? (run.running && !onCancel ? "Add a message for the running agent…" : "Ask anything…")}
					value={text}
					onInput={event => setText(event.currentTarget.value)}
					onKeyDown={onKeyDown}
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
						<ModelPicker models={models} selectedModelId={selectedModelId} onSelectModel={onSelectModel} />
						{selectedModel?.thinking
							? <ThinkingPicker thinking={selectedModel.thinking} selected={selectedThinking} onSelect={onSelectThinking} />
							: null}
						<ToolPicker tools={tools} onSetToolsEnabled={onSetToolsEnabled} />
						<QuotaIndicator quota={quota} provider={selectedGroup?.provider} onRefresh={onRefreshQuota} />
					</div>
					<div class="composer-actions">
						{cache ? <span class={`cache-indicator cache-${cache.level}`} title={cache.title}>{cache.text}</span> : null}
						{context ? <span class="context-indicator" title="Prompt tokens / context window">{context}</span> : null}
						{run.running && !onCancel ? (
							<>
								<button type="button" class="send-button send-button-stop" aria-label="Stop" title="Stop" onClick={onStop}>
									<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
										<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
									</svg>
								</button>
								{sendButton}
							</>
						) : (
							<>
								{onCancel ? (
									<button type="button" class="composer-cancel" onClick={onCancel}>Cancel</button>
								) : null}
								{sendButton}
							</>
						)}
					</div>
				</div>
			</div>
			{footer}
		</div>
	);
}
