import { useCallback, useLayoutEffect, useState } from "preact/hooks";
import type { ChatAttachment, ChatModelGroup, ChatUsage } from "../shared/protocol";
import { ActivityBadge } from "./activity-badge";
import { postMessage } from "./api";
import { ApprovalCard } from "./approval-card";
import { ChangesPanel } from "./changes-panel";
import { ChatHistory } from "./chat-history";
import { Composer } from "./composer";
import { formatTokens } from "./format";
import { MessageList } from "./message-list";
import type { ChatStore } from "./store";

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
	const [badgeOpens, setBadgeOpens] = useState(0);
	// Layout effect: subscribe before the host's init message can be delivered.
	useLayoutEffect(() => store.subscribe(() => setRevision(revision => revision + 1)), [store]);

	const onSend = useCallback((text: string) => {
		const attachments = store.takeAttachments();
		postMessage(attachments.length > 0 ? { type: "send", text, attachments } : { type: "send", text });
	}, [store]);
	const onStop = useCallback(() => postMessage({ type: "stop" }), []);
	const onPickAttachments = useCallback(() => postMessage({ type: "pickAttachments" }), []);
	const onAddAttachments = useCallback((uris: string[]) => postMessage({ type: "addAttachments", uris }), []);
	const onOpenAttachment = useCallback((attachment: ChatAttachment) => postMessage({ type: "openAttachment", attachment }), []);
	const onRemoveAttachment = useCallback((id: string) => store.removeAttachment(id), [store]);
	const onSelectModel = useCallback((modelId: string) => postMessage({ type: "selectModel", modelId }), []);
	const onSelectThinking = useCallback((value: string) => postMessage({ type: "selectThinking", value }), []);
	const onRefreshQuota = useCallback(() => postMessage({ type: "refreshQuota" }), []);
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
	const onListSessions = useCallback(() => postMessage({ type: "listSessions" }), []);
	const onOpenSession = useCallback((sessionId: string) => postMessage({ type: "openSession", sessionId }), []);
	const onDeleteSession = useCallback((sessionId: string) => postMessage({ type: "deleteSession", sessionId }), []);
	const onShowActivity = useCallback(() => setBadgeOpens(count => count + 1), []);
	const onNewChat = useCallback(() => postMessage({ type: "newChat" }), []);

	const title = store.session?.title ?? "Chat";
	const context = contextIndicator(store.latestUsage, store.models, store.selectedModelId);

	return (
		<div class="chat-root">
			<header class="chat-header">
				<ChatHistory
					title={title}
					sessions={store.sessions}
					activeId={store.activeSessionId}
					activity={store.activity}
					activeRunning={store.run.running}
					openRequest={store.showSessionsRequest + badgeOpens}
					onList={onListSessions}
					onOpen={onOpenSession}
					onDelete={onDeleteSession}
					onNewChat={onNewChat}
				/>
				<ActivityBadge activity={store.activity} onClick={onShowActivity} />
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
				selectedThinking={store.selectedThinking}
				quota={store.quota}
				context={context}
				pendingAttachments={store.pendingAttachments}
				onSend={onSend}
				onStop={onStop}
				onSelectModel={onSelectModel}
				onSelectThinking={onSelectThinking}
				onRefreshQuota={onRefreshQuota}
				onSetToolsEnabled={onSetToolsEnabled}
				onPickAttachments={onPickAttachments}
				onAddAttachments={onAddAttachments}
				onOpenAttachment={onOpenAttachment}
				onRemoveAttachment={onRemoveAttachment}
			/>
		</div>
	);
}
