import type { ChatQueuedMessage } from "../shared/protocol";

interface QueuedMessagesProps {
	queued: ChatQueuedMessage[];
	onRemove: (id: string) => void;
}

export function QueuedMessages({ queued, onRemove }: QueuedMessagesProps) {
	if (queued.length === 0) {
		return null;
	}
	return (
		<div class="queued-messages" aria-label="Queued messages">
			<div class="queued-messages-head">Sent after the current tool call</div>
			{queued.map(message => (
				<div class="queued-message" key={message.id}>
					<span class="queued-message-text" title={message.text}>{message.text}</span>
					{message.attachments && message.attachments.length > 0 ? (
						<span class="queued-message-files">{`+${message.attachments.length} ${message.attachments.length === 1 ? "file" : "files"}`}</span>
					) : null}
					<button
						type="button"
						class="queued-message-remove"
						aria-label="Remove queued message"
						title="Remove"
						onClick={() => onRemove(message.id)}
					>
						×
					</button>
				</div>
			))}
		</div>
	);
}
