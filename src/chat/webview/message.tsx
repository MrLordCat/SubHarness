import { Component } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatMessage, ChatPart } from "../shared/protocol";
import { Markdown } from "./markdown";

type ToolResultPart = Extract<ChatPart, { kind: "toolResult" }>;

export interface MessageItemProps {
	message: ChatMessage;
	version: number;
	running: boolean;
	editing: boolean;
	/** Files the agent changed at or after this message's turn; used when editing. */
	changedFilesSinceTurn: number;
	onEdit: (messageId: string) => void;
	onCancelEdit: () => void;
	onEditMessage: (messageId: string, text: string, undoChanges: boolean) => void;
	onLoadToolResult: (messageId: string, callId: string) => void;
}

/** Only a changed version reaches the render below; the list around it stays put. */
class MessageItemMemo extends Component<MessageItemProps> {
	shouldComponentUpdate(next: MessageItemProps): boolean {
		return next.version !== this.props.version
			|| next.message !== this.props.message
			|| next.running !== this.props.running
			|| next.editing !== this.props.editing
			|| (next.editing && next.changedFilesSinceTurn !== this.props.changedFilesSinceTurn);
	}

	render(props: MessageItemProps) {
		return <MessageView {...props} />;
	}
}

export const MessageItem = MessageItemMemo;

function MessageView({ message, running, editing, changedFilesSinceTurn, onEdit, onCancelEdit, onEditMessage, onLoadToolResult }: Omit<MessageItemProps, "version">) {
	if (message.role === "user") {
		const text = message.parts
			.flatMap(part => part.kind === "text" ? [part.text] : [])
			.join("\n\n");
		if (editing) {
			return (
				<div class="msg msg-user msg-editing">
					<UserEdit
						messageId={message.id}
						text={text}
						changedFilesSinceTurn={changedFilesSinceTurn}
						onSubmit={onEditMessage}
						onCancel={onCancelEdit}
					/>
				</div>
			);
		}
		return (
			<div class="msg msg-user">
				{running ? null : (
					<button type="button" class="msg-edit-button" onClick={() => onEdit(message.id)}>Edit</button>
				)}
				<div class="user-bubble">{text}</div>
			</div>
		);
	}

	const calls = new Set<string>();
	const results = new Map<string, ToolResultPart>();
	for (const part of message.parts) {
		if (part.kind === "toolCall") {
			calls.add(part.callId);
		} else if (part.kind === "toolResult") {
			results.set(part.callId, part);
		}
	}

	return (
		<div class="msg msg-assistant">
			{message.parts.map((part, index) => {
				switch (part.kind) {
					case "text":
						return <Markdown key={index} text={part.text} />;
					case "thinking":
						return (
							<details key={index} class="msg-thinking">
								<summary>Thinking</summary>
								<pre>{part.text}</pre>
							</details>
						);
					case "toolCall":
						return (
							<ToolCallCard
								key={index}
								name={part.name}
								input={part.input}
								result={results.get(part.callId)}
								messageId={message.id}
								onLoadToolResult={onLoadToolResult}
							/>
						);
					case "toolResult":
						return calls.has(part.callId)
							? null
							: <ToolResultCard key={index} part={part} messageId={message.id} onLoadToolResult={onLoadToolResult} />;
					case "notice":
						return <div key={index} class={`msg-notice notice-${part.level}`}>{part.text}</div>;
				}
			})}
		</div>
	);
}

function summarizeInput(input: unknown): string {
	let text: string;
	try {
		text = typeof input === "string" ? input : JSON.stringify(input) ?? String(input);
	} catch {
		text = String(input);
	}
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length > 160 ? `${singleLine.slice(0, 159)}…` : singleLine;
}

interface ToolCallProps {
	name: string;
	input: unknown;
	result: ToolResultPart | undefined;
	messageId: string;
	onLoadToolResult: (messageId: string, callId: string) => void;
}

interface ToolResultProps {
	part: ToolResultPart;
	messageId: string;
	onLoadToolResult: (messageId: string, callId: string) => void;
}

function ToolCallCard({ name, input, result, messageId, onLoadToolResult }: ToolCallProps) {
	const summary = summarizeInput(input);
	return (
		<div class={`tool-card${result?.isError ? " tool-error" : ""}`}>
			<div class="tool-head">
				<span class="tool-name">{name}</span>
				<span class="tool-summary" title={summary}>{summary}</span>
			</div>
			{result ? <ToolResultDetails part={result} messageId={messageId} onLoadToolResult={onLoadToolResult} /> : null}
		</div>
	);
}

function ToolResultCard({ part, messageId, onLoadToolResult }: ToolResultProps) {
	return (
		<div class={`tool-card tool-result-card${part.isError ? " tool-error" : ""}`}>
			<div class="tool-head">
				<span class="tool-name">{part.isError ? "Tool error" : "Tool result"}</span>
			</div>
			<ToolResultDetails part={part} messageId={messageId} onLoadToolResult={onLoadToolResult} />
		</div>
	);
}

function ToolResultDetails({ part, messageId, onLoadToolResult }: ToolResultProps) {
	return (
		<details class={`tool-result${part.isError ? " tool-result-error" : ""}`}>
			<summary>{part.isError ? "Error output" : "Output"}{part.preview ? " (preview)" : ""}</summary>
			<pre class="tool-output">{part.text}</pre>
			{part.preview ? (
				<button
					type="button"
					class="tool-full"
					onClick={() => onLoadToolResult(messageId, part.callId)}
				>
					Show full output
				</button>
			) : null}
		</details>
	);
}

interface UserEditProps {
	messageId: string;
	text: string;
	changedFilesSinceTurn: number;
	onSubmit: (messageId: string, text: string, undoChanges: boolean) => void;
	onCancel: () => void;
}

function UserEdit({ messageId, text, changedFilesSinceTurn, onSubmit, onCancel }: UserEditProps) {
	const [draft, setDraft] = useState(text);
	const [undoChanges, setUndoChanges] = useState(changedFilesSinceTurn > 0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	}, []);

	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.style.height = "auto";
		const limit = Math.max(80, Math.round(document.documentElement.clientHeight * 0.4));
		textarea.style.height = `${Math.min(textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight, limit)}px`;
	}, [draft]);

	const submit = () => {
		// The field may be newer than the last render, e.g. Enter right after a paste.
		const trimmed = (textareaRef.current?.value ?? draft).trim();
		if (trimmed.length > 0) {
			onSubmit(messageId, trimmed, changedFilesSinceTurn > 0 && undoChanges);
		}
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onCancel();
			return;
		}
		if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
			return;
		}
		event.preventDefault();
		submit();
	};

	return (
		<div class="msg-edit">
			<textarea
				ref={textareaRef}
				class="composer-input msg-edit-input"
				rows={1}
				aria-label="Edit message"
				value={draft}
				onInput={event => setDraft(event.currentTarget.value)}
				onKeyDown={onKeyDown}
			/>
			{changedFilesSinceTurn > 0 ? (
				<label class="msg-edit-undo">
					<input
						type="checkbox"
						checked={undoChanges}
						onChange={event => setUndoChanges(event.currentTarget.checked)}
					/>
					{`Also undo changes to ${changedFilesSinceTurn === 1 ? "1 file" : `${changedFilesSinceTurn} files`} made since this message`}
				</label>
			) : null}
			<div class="msg-edit-actions">
				<button type="button" class="send-button msg-edit-send" disabled={draft.trim().length === 0} onClick={submit}>Send</button>
				<button type="button" class="msg-edit-cancel" onClick={onCancel}>Cancel</button>
			</div>
			<div class="msg-edit-hint">Sending replaces this message and every message after it.</div>
		</div>
	);
}
