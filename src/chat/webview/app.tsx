import { useCallback, useLayoutEffect, useState } from "preact/hooks";
import type { ChatQuestionAnswer } from "../shared/protocol";
import { ActivityBadge } from "./activity-badge";
import { postMessage } from "./api";
import { ApprovalCard } from "./approval-card";
import { ChangesPanel } from "./changes-panel";
import { ChatHistory } from "./chat-history";
import { Composer } from "./composer";
import { useComposerActions } from "./composer-actions";
import { contextIndicator, contextIndicatorTitle, formatCacheHit, modelCacheStats, selectedModelProvider } from "./format";
import { MemoryPanel } from "./memory-panel";
import { MessageList } from "./message-list";
import { OpenSubagentsPanel } from "./open-subagents";
import { QueuedMessages } from "./queued-messages";
import { QuestionCard } from "./question-card";
import type { ChatStore } from "./store";
import { TodoPanel } from "./todo-panel";

export function App({ store }: { store: ChatStore }) {
	const [, setRevision] = useState(0);
	const [badgeOpens, setBadgeOpens] = useState(0);
	// Layout effect: subscribe before the host's init message can be delivered.
	useLayoutEffect(() => store.subscribe(() => setRevision(revision => revision + 1)), [store]);

	const onSend = useCallback((text: string) => {
		const attachments = store.takeAttachments();
		postMessage(attachments.length > 0 ? { type: "send", text, attachments } : { type: "send", text });
	}, [store]);
	const onEditLast = useCallback(() => {
		if (store.editing) {
			return;
		}
		const message = [...store.messages].reverse().find(candidate => candidate.role === "user" && !candidate.continuation);
		if (message) {
			store.startEdit(message.id);
		}
	}, [store]);
	const {
		onStop,
		onSelectModel,
		onSetFavoriteModel,
		onSelectThinking,
		onRefreshQuota,
		onSetToolsEnabled,
		onPickAttachments,
		onAddAttachments,
		onPasteFiles,
		onSignIn,
		onOpenAttachment,
		onRemoveAttachment,
	} = useComposerActions(store);
	const onApprove = useCallback((id: string, allow: boolean) => postMessage({ type: "approve", id, allow }), []);
	const onAnswer = useCallback((id: string, answers?: ChatQuestionAnswer[]) => postMessage(answers ? { type: "answerQuestions", id, answers } : { type: "answerQuestions", id }), []);
	const onListSessions = useCallback(() => postMessage({ type: "listSessions" }), []);
	const onListMemory = useCallback(() => postMessage({ type: "listMemory" }), []);
	// The pending draft goes first, so the host keeps a chat that has only unsent text.
	const onOpenSession = useCallback((sessionId: string) => {
		store.flushDraft();
		postMessage({ type: "openSession", sessionId });
	}, [store]);
	const onDeleteSession = useCallback((sessionId: string) => {
		store.flushDraft();
		postMessage({ type: "deleteSession", sessionId });
	}, [store]);
	const onShowActivity = useCallback(() => setBadgeOpens(count => count + 1), []);
	const onNewChat = useCallback(() => {
		store.flushDraft();
		postMessage({ type: "newChat" });
	}, [store]);
	const onRemoveQueued = useCallback((id: string) => postMessage({ type: "removeQueued", id }), []);

	const title = store.session?.title ?? "Chat";
	const context = contextIndicator(store.latestUsage, store.models, store.selectedModelId);
	const contextTitle = contextIndicatorTitle(store.models, store.selectedModelId);
	const cacheStats = modelCacheStats(store.messages, store.selectedModelId);
	const cache = cacheStats ? formatCacheHit(cacheStats, selectedModelProvider(store.models, store.selectedModelId)) : undefined;

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
					onRename={(sessionId, title) => postMessage({ type: "renameSession", sessionId, title })}
					onExport={sessionId => postMessage({ type: "exportSession", sessionId })}
					onNewChat={onNewChat}
				/>
				<MemoryPanel memory={store.memory} onList={onListMemory} />
				<ActivityBadge activity={store.activity} onClick={onShowActivity} />
			</header>
			{store.messages.length === 0 ? (
				<div class="chat-empty">Ask anything. Enter sends, Shift+Enter adds a line.</div>
			) : (
				<MessageList
					store={store}
					running={store.run.running}
					context={context}
				/>
			)}
			{store.run.running && store.run.detail ? <div class="run-status" role="status">{store.run.detail}</div> : null}
			{store.todoList && store.todoList.length > 0 && (store.run.running || store.todoList.some(todo => todo.status !== "completed")) ? (
				<TodoPanel todos={store.todoList} running={store.run.running} />
			) : null}
			{store.changes.files.length > 0 || store.changes.notice || store.changes.unavailable ? (
				<ChangesPanel changes={store.changes} running={store.run.running} />
			) : null}
			{store.approvals.length > 0 || store.questionRequests.length > 0 ? (
				<div class="approval-stack">
					{store.approvals.map(request => (
						<ApprovalCard key={request.id} request={request} onApprove={onApprove} />
					))}
					{store.questionRequests.map(request => (
						<QuestionCard key={request.id} request={request} onAnswer={onAnswer} />
					))}
				</div>
			) : null}
			<OpenSubagentsPanel store={store} />
			<QueuedMessages queued={store.queued} onRemove={onRemoveQueued} />
			<Composer
				key={`composer-${store.composerKey}`}
				initialText={store.draftText}
				onTextChange={store.setDraftText}
				run={store.run}
				models={store.models}
				tools={store.tools}
				selectedModelId={store.selectedModelId}
				selectedThinking={store.selectedThinking}
				cache={cache}
				quota={store.quota}
				context={context}
				contextTitle={contextTitle}
				contextSettings={store.contextSettings}
				attachments={store.pendingAttachments}
				draft={store.draftRequest}
				onSend={onSend}
				onEditLast={onEditLast}
				onStop={onStop}
				onSelectModel={onSelectModel}
				favoriteModels={store.favoriteModels}
				onSetFavoriteModel={onSetFavoriteModel}
				onSelectThinking={onSelectThinking}
				onRefreshQuota={onRefreshQuota}
				onSetToolsEnabled={onSetToolsEnabled}
				onPickAttachments={onPickAttachments}
				onAddAttachments={onAddAttachments}
				onPasteFiles={onPasteFiles}
				signIn={store.signIn}
				onSignIn={onSignIn}
				onOpenAttachment={onOpenAttachment}
				onRemoveAttachment={onRemoveAttachment}
			/>
		</div>
	);
}
