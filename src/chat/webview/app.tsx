import { useCallback, useLayoutEffect, useState } from "preact/hooks";
import type { ChatModelGroup, ChatUsage } from "../shared/protocol";
import { postMessage } from "./api";
import { ApprovalCard } from "./approval-card";
import { ChangesPanel } from "./changes-panel";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import type { ChatStore } from "./store";

function formatTokens(value: number): string {
	if (value >= 1_000_000) {
		return `${formatScaled(value / 1_000_000)}M`;
	}
	if (value >= 1_000) {
		return `${formatScaled(value / 1_000)}k`;
	}
	return `${Math.round(value)}`;
}

function formatScaled(value: number): string {
	const text = value >= 100 ? `${Math.round(value)}` : value.toFixed(1);
	return text.endsWith(".0") ? text.slice(0, -2) : text;
}

function contextIndicator(latestUsage: ChatUsage | undefined, models: ChatModelGroup[], selectedModelId: string | undefined): string | undefined {
	const promptTokens = latestUsage?.promptTokens;
	if (promptTokens === undefined) {
		return undefined;
	}
	const model = models.flatMap(group => group.models).find(candidate => candidate.id === selectedModelId);
	if (!model || model.maxInputTokens <= 0) {
		return undefined;
	}
	return `${formatTokens(promptTokens)} / ${formatTokens(model.maxInputTokens)}`;
}

export function App({ store }: { store: ChatStore }) {
	const [, setRevision] = useState(0);
	// Layout effect: subscribe before the host's init message can be delivered.
	useLayoutEffect(() => store.subscribe(() => setRevision(revision => revision + 1)), [store]);

	const onSend = useCallback((text: string) => postMessage({ type: "send", text }), []);
	const onStop = useCallback(() => postMessage({ type: "stop" }), []);
	const onSelectModel = useCallback((modelId: string) => postMessage({ type: "selectModel", modelId }), []);
	const onEditMessage = useCallback(
		(messageId: string, text: string, undoChanges: boolean) => {
			postMessage(undoChanges
				? { type: "editMessage", messageId, text, undoChanges: true }
				: { type: "editMessage", messageId, text });
		},
		[],
	);
	const onSetToolsEnabled = useCallback((names: string[], enabled: boolean) => {
		store.setToolsEnabled(names, enabled);
		postMessage({ type: "setToolsEnabled", names, enabled });
	}, [store]);
	const onApprove = useCallback((id: string, allow: boolean) => postMessage({ type: "approve", id, allow }), []);
	const onLoadToolResult = useCallback(
		(messageId: string, callId: string) => postMessage({ type: "loadToolResult", messageId, callId }),
		[],
	);

	const title = store.session?.title ?? "Chat";
	const context = contextIndicator(store.latestUsage, store.models, store.selectedModelId);

	return (
		<div class="chat-root">
			<header class="chat-header">
				<div class="chat-title" title={title}>{title}</div>
			</header>
			{store.messages.length === 0 ? (
				<div class="chat-empty">Ask anything. Enter sends, Shift+Enter adds a line.</div>
			) : (
				<MessageList
					store={store}
					running={store.run.running}
					onEditMessage={onEditMessage}
					onLoadToolResult={onLoadToolResult}
				/>
			)}
			{store.run.running && store.run.detail ? <div class="run-status" role="status">{store.run.detail}</div> : null}
			{store.changes.files.length > 0 || store.changes.notice || store.changes.unavailable ? (
				<ChangesPanel changes={store.changes} running={store.run.running} />
			) : null}
			{store.approvals.length > 0 ? (
				<div class="approval-stack">
					{store.approvals.map(request => (
						<ApprovalCard key={request.id} request={request} onApprove={onApprove} />
					))}
				</div>
			) : null}
			<Composer
				run={store.run}
				models={store.models}
				tools={store.tools}
				selectedModelId={store.selectedModelId}
				context={context}
				onSend={onSend}
				onStop={onStop}
				onSelectModel={onSelectModel}
				onSetToolsEnabled={onSetToolsEnabled}
			/>
		</div>
	);
}
