import { Component } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatLimitInfo, ChatMessage, ChatPart, ChatSubagentRun, ChatSubagentStep } from "../shared/protocol";
import { SUBAGENT_TOOL_NAME } from "../tools/subagent-tool";
import { OPEN_MODEL_PICKER_EVENT } from "./events";
import { formatReset, formatTokens } from "./format";
import { Markdown } from "./markdown";

type ToolResultPart = Extract<ChatPart, { kind: "toolResult" }>;
type CompactionPart = Extract<ChatPart, { kind: "compaction" }>;

export interface MessageItemProps {
	message: ChatMessage;
	version: number;
	running: boolean;
	editing: boolean;
	/** The latest compaction keeps this message, so the summarized divider sits above it. */
	compactionBoundary: boolean;
	/** Files the agent changed at or after this message's turn; used when editing. */
	changedFilesSinceTurn: number;
	onEdit: (messageId: string) => void;
	onCancelEdit: () => void;
	onEditMessage: (messageId: string, text: string, undoChanges: boolean) => void;
	onLoadToolResult: (messageId: string, callId: string) => void;
	/** Live state of a running subagent; the finished run is a "subagent" part of the message. */
	liveSubagentRun: (callId: string) => ChatSubagentRun | undefined;
}

/** Only a changed version reaches the render below; the list around it stays put. */
class MessageItemMemo extends Component<MessageItemProps> {
	shouldComponentUpdate(next: MessageItemProps): boolean {
		return next.version !== this.props.version
			|| next.message !== this.props.message
			|| next.running !== this.props.running
			|| next.editing !== this.props.editing
			|| next.compactionBoundary !== this.props.compactionBoundary
			|| (next.editing && next.changedFilesSinceTurn !== this.props.changedFilesSinceTurn);
	}

	render(props: MessageItemProps) {
		return <MessageView {...props} />;
	}
}

export const MessageItem = MessageItemMemo;

function MessageView({ message, running, editing, compactionBoundary, changedFilesSinceTurn, onEdit, onCancelEdit, onEditMessage, onLoadToolResult, liveSubagentRun }: Omit<MessageItemProps, "version">) {
	const divider = compactionBoundary
		? <div class="compaction-divider">Earlier messages are summarized for the model</div>
		: null;
	if (message.role === "user") {
		const text = message.parts
			.flatMap(part => part.kind === "text" ? [part.text] : [])
			.join("\n\n");
		if (editing) {
			return (
				<>
					{divider}
					<div class="msg msg-user msg-editing">
						<UserEdit
							messageId={message.id}
							text={text}
							changedFilesSinceTurn={changedFilesSinceTurn}
							onSubmit={onEditMessage}
							onCancel={onCancelEdit}
						/>
					</div>
				</>
			);
		}
		return (
			<>
				{divider}
				<div class="msg msg-user">
					{running ? null : (
						<button type="button" class="msg-edit-button" onClick={() => onEdit(message.id)}>Edit</button>
					)}
					<div class="user-bubble">{text}</div>
				</div>
			</>
		);
	}

	const calls = new Set<string>();
	const results = new Map<string, ToolResultPart>();
	const subagentRuns = new Map<string, ChatSubagentRun>();
	for (const part of message.parts) {
		if (part.kind === "toolCall") {
			calls.add(part.callId);
		} else if (part.kind === "toolResult") {
			results.set(part.callId, part);
		} else if (part.kind === "subagent") {
			subagentRuns.set(part.callId, part);
		}
	}

	return (
		<>
			{divider}
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
							if (part.name === SUBAGENT_TOOL_NAME) {
								return (
									<SubagentCard
										key={index}
										input={part.input}
										result={results.get(part.callId)}
										part={subagentRuns.get(part.callId)}
										liveRun={liveSubagentRun(part.callId)}
										messageId={message.id}
										onLoadToolResult={onLoadToolResult}
									/>
								);
							}
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
						case "subagent":
							return null;
						case "notice":
							return part.limit
								? <LimitCard key={index} level={part.level} text={part.text} limit={part.limit} />
								: <div key={index} class={`msg-notice notice-${part.level}`}>{part.text}</div>;
						case "compaction":
							return <CompactionCard key={index} part={part} />;
					}
				})}
			</div>
		</>
	);
}

function CompactionCard({ part }: { part: CompactionPart }) {
	const method = part.method === "deepseek" ? "DeepSeek summary" : "extractive summary";
	return (
		<div class="compaction-card">
			<div class="compaction-line">
				<span class="compaction-label">Context compacted:</span>
				{` ${part.summarizedMessages} earlier messages summarized · ${formatTokens(part.tokensBefore)} → ${formatTokens(part.tokensAfter)} tokens`}
				<span class="compaction-method">{` (${method})`}</span>
			</div>
			<details class="compaction-summary">
				<summary>Summary</summary>
				<Markdown text={part.summary} />
			</details>
		</div>
	);
}

interface LimitCardProps {
	level: "info" | "warning" | "error";
	text: string;
	limit: ChatLimitInfo;
}

function LimitCard({ level, text, limit }: LimitCardProps) {
	const heading = limit.kind === "balance"
		? `${limit.provider} balance is empty`
		: `${limit.provider} usage limit reached`;
	return (
		<div class={`limit-card notice-${level}`}>
			<div class="limit-heading">{heading}</div>
			<div class="limit-text">{text}</div>
			{limit.resetAt !== undefined ? (
				<div class="limit-reset">{`Resets at ${formatReset(limit.resetAt, Date.now())}`}</div>
			) : null}
			<button
				type="button"
				class="limit-model-button"
				onClick={() => window.dispatchEvent(new CustomEvent(OPEN_MODEL_PICKER_EVENT))}
			>
				Choose another model
			</button>
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

function ToolResultDetails({ part, messageId, onLoadToolResult, report }: ToolResultProps & { report?: boolean }) {
	const markdown = report === true && !part.isError;
	return (
		<details class={`tool-result${part.isError ? " tool-result-error" : ""}`} open={markdown}>
			<summary>{part.isError ? "Error output" : markdown ? "Report" : "Output"}{part.preview ? " (preview)" : ""}</summary>
			{markdown ? <div class="tool-report"><Markdown text={part.text} /></div> : <pre class="tool-output">{part.text}</pre>}
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

interface SubagentInput {
	description: string;
	model: string;
}

function readSubagentInput(input: unknown): SubagentInput {
	const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
	return {
		description: typeof record.description === "string" ? record.description : "",
		model: typeof record.model === "string" ? record.model : "",
	};
}

function formatDuration(ms: number): string {
	if (ms < 1_000) {
		return `${Math.max(0, Math.round(ms))} ms`;
	}
	const totalSeconds = Math.round(ms / 1_000);
	if (totalSeconds < 60) {
		return `${totalSeconds} s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

function subagentStatusText(run: ChatSubagentRun): string {
	const steps = `${run.steps.length} ${run.steps.length === 1 ? "step" : "steps"}`;
	const elapsed = run.durationMs ?? Math.max(0, Date.now() - run.startedAt);
	switch (run.status) {
		case "running": return `Working… ${steps} · ${formatDuration(elapsed)}`;
		case "done": return `Done · ${steps} · ${formatDuration(elapsed)}`;
		case "failed": return `Failed · ${steps} · ${formatDuration(elapsed)}`;
		case "stopped": return `Stopped · ${steps} · ${formatDuration(elapsed)}`;
	}
}

function SubagentStepView({ step }: { step: ChatSubagentStep }) {
	switch (step.kind) {
		case "tool":
			return (
				<div class={`subagent-step subagent-step-tool${step.isError ? " tool-error" : ""}`}>
					<span class="subagent-step-name">{step.name}</span>
					<span class="subagent-step-summary" title={step.summary}>{step.summary}</span>
				</div>
			);
		case "text":
			return (
				<div class="subagent-step subagent-step-text">
					<Markdown text={step.text} />
				</div>
			);
		case "notice":
			return <div class={`subagent-step subagent-step-notice notice-${step.level}`}>{step.text}</div>;
	}
}

interface SubagentCardProps {
	input: unknown;
	result: ToolResultPart | undefined;
	/** The finished run, from the message's "subagent" part. */
	part: ChatSubagentRun | undefined;
	liveRun: ChatSubagentRun | undefined;
	messageId: string;
	onLoadToolResult: (messageId: string, callId: string) => void;
}

function SubagentCard({ input, result, part, liveRun, messageId, onLoadToolResult }: SubagentCardProps) {
	const parsed = readSubagentInput(input);
	const run = part ?? liveRun;
	const description = run?.description || parsed.description;
	const model = run?.modelName || parsed.model;
	const failed = run?.status === "failed" || result?.isError === true;
	return (
		<div class={`tool-card subagent-card${run ? ` subagent-${run.status}` : ""}${failed ? " tool-error" : ""}`}>
			<div class="tool-head subagent-head">
				<span class="tool-name">Subagent</span>
				{model ? <span class="subagent-model">{model}</span> : null}
				{description ? <span class="tool-summary" title={description}>{description}</span> : null}
			</div>
			{run ? <div class="subagent-status">{subagentStatusText(run)}</div> : null}
			{run && run.steps.length > 0 ? (
				<details class="subagent-steps">
					<summary>Steps</summary>
					<div class="subagent-step-list">
						{run.steps.map((step, index) => <SubagentStepView key={index} step={step} />)}
					</div>
				</details>
			) : null}
			{result ? <ToolResultDetails part={result} messageId={messageId} onLoadToolResult={onLoadToolResult} report /> : null}
		</div>
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
