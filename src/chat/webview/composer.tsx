import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatModelGroup, ChatProviderQuota, ChatRunState, ChatToolGroup } from "../shared/protocol";
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
	onSend: (text: string) => void;
	onStop: () => void;
	onSelectModel: (modelId: string) => void;
	onSelectThinking: (value: string) => void;
	onRefreshQuota: () => void;
	onSetToolsEnabled: (names: string[], enabled: boolean) => void;
}

export function Composer({
	run,
	models,
	tools,
	selectedModelId,
	selectedThinking,
	quota,
	context,
	onSend,
	onStop,
	onSelectModel,
	onSelectThinking,
	onRefreshQuota,
	onSetToolsEnabled,
}: ComposerProps) {
	const [text, setText] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

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

	const canSend = text.trim().length > 0 && !run.running;
	const selectedGroup = models.find(group => group.models.some(model => model.id === selectedModelId));
	const selectedModel = selectedGroup?.models.find(model => model.id === selectedModelId);
	const submit = () => {
		if (!canSend) {
			return;
		}
		onSend(text);
		setText("");
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
			return;
		}
		if (run.running) {
			return;
		}
		event.preventDefault();
		submit();
	};

	return (
		<div class="composer">
			<textarea
				ref={textareaRef}
				class="composer-input"
				rows={1}
				placeholder="Ask anything…"
				value={text}
				onInput={event => setText(event.currentTarget.value)}
				onKeyDown={onKeyDown}
			/>
			<div class="composer-row">
				<ModelPicker models={models} selectedModelId={selectedModelId} onSelectModel={onSelectModel} />
				{selectedModel?.thinking
					? <ThinkingPicker thinking={selectedModel.thinking} selected={selectedThinking} onSelect={onSelectThinking} />
					: null}
				<ToolPicker tools={tools} onSetToolsEnabled={onSetToolsEnabled} />
				<QuotaIndicator quota={quota} provider={selectedGroup?.provider} onRefresh={onRefreshQuota} />
				{context ? <span class="context-indicator" title="Prompt tokens / context window">{context}</span> : null}
				{run.running ? (
					<button type="button" class="send-button" onClick={onStop}>Stop</button>
				) : (
					<button type="button" class="send-button" disabled={!canSend} onClick={submit}>Send</button>
				)}
			</div>
		</div>
	);
}
