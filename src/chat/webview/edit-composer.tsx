import { useLayoutEffect, useState } from "preact/hooks";
import type { ChatMessage } from "../shared/protocol";
import { postMessage } from "./api";
import { Composer } from "./composer";
import { useComposerActions } from "./composer-actions";
import { formatCacheHit, modelCacheStats, selectedModelProvider } from "./format";
import type { ChatStore } from "./store";

interface EditComposerProps {
	store: ChatStore;
	message: ChatMessage;
	changedFilesSinceTurn: number;
	context: string | undefined;
}

/** The full composer, opened in place of a sent user message. */
export function EditComposer({ store, message, changedFilesSinceTurn, context }: EditComposerProps) {
	const [, setRevision] = useState(0);
	// The message item is memoized, so pickers and attachments need their own subscription.
	useLayoutEffect(() => store.subscribe(() => setRevision(revision => revision + 1)), [store]);
	const actions = useComposerActions(store);
	const [undoChanges, setUndoChanges] = useState(changedFilesSinceTurn > 0);
	const attachments = store.editing?.attachments ?? [];
	const text = message.parts
		.flatMap(part => part.kind === "text" ? [part.text] : [])
		.join("\n\n");
	const cacheStats = modelCacheStats(store.messages, store.selectedModelId);

	const submit = (value: string) => {
		postMessage({
			type: "editMessage",
			messageId: message.id,
			text: value.trim(),
			attachments,
			...(undoChanges && changedFilesSinceTurn > 0 ? { undoChanges: true } : {}),
		});
		store.cancelEdit();
	};

	return (
		<Composer
			class="composer-edit"
			autoFocus
			initialText={text}
			run={store.run}
			models={store.models}
			tools={store.tools}
			selectedModelId={store.selectedModelId}
			selectedThinking={store.selectedThinking}
			quota={store.quota}
			cache={cacheStats ? formatCacheHit(cacheStats, selectedModelProvider(store.models, store.selectedModelId)) : undefined}
			context={context}
			attachments={attachments}
			onSend={submit}
			onCancel={() => store.cancelEdit()}
			onStop={actions.onStop}
			onSelectModel={actions.onSelectModel}
			onSelectThinking={actions.onSelectThinking}
			onRefreshQuota={actions.onRefreshQuota}
			onSetToolsEnabled={actions.onSetToolsEnabled}
			onPickAttachments={actions.onPickAttachments}
			onAddAttachments={actions.onAddAttachments}
			onOpenAttachment={actions.onOpenAttachment}
			onRemoveAttachment={id => store.removeEditAttachment(id)}
			footer={(
				<div class="composer-footer">
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
					<div class="msg-edit-hint">Sending replaces this message and every message after it.</div>
				</div>
			)}
		/>
	);
}
