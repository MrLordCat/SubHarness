import { useState } from "preact/hooks";
import type { ChatChangedFile, ChatChangeSet } from "../shared/protocol";
import { postMessage } from "./api";

const STATUS_LETTER: Record<ChatChangedFile["status"], string> = {
	added: "A",
	modified: "M",
	deleted: "D",
};

const STATUS_NAME: Record<ChatChangedFile["status"], string> = {
	added: "Added",
	modified: "Modified",
	deleted: "Deleted",
};

function knownTotal(files: ChatChangedFile[], key: "additions" | "deletions"): number | undefined {
	let total: number | undefined;
	for (const file of files) {
		const value = file[key];
		if (value !== undefined) {
			total = (total ?? 0) + value;
		}
	}
	return total;
}

function pluralFiles(count: number): string {
	return count === 1 ? "1 file" : `${count} files`;
}

interface ChangesPanelProps {
	changes: ChatChangeSet;
	running: boolean;
}

export function ChangesPanel({ changes, running }: ChangesPanelProps) {
	const [expanded, setExpanded] = useState(false);
	const count = changes.files.length;

	if (count === 0) {
		const text = changes.unavailable ? `Change tracking is off: ${changes.unavailable}` : changes.notice;
		return text ? <div class="changes-panel"><div class="changes-notice">{text}</div></div> : null;
	}

	const additions = knownTotal(changes.files, "additions");
	const deletions = knownTotal(changes.files, "deletions");

	return (
		<div class="changes-panel" role="region" aria-label="Changed files">
			<div class="changes-head">
				<button
					type="button"
					class="changes-toggle"
					aria-expanded={expanded}
					onClick={() => setExpanded(value => !value)}
				>
					<span class="changes-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
					<span class="changes-count">{`${pluralFiles(count)} changed`}</span>
				</button>
				{additions !== undefined ? <span class="change-additions">+{additions}</span> : null}
				{deletions !== undefined ? <span class="change-deletions">−{deletions}</span> : null}
				<span class="changes-actions">
					<button
						type="button"
						class="changes-button changes-keep"
						title="Keep all changed files"
						aria-label="Keep all changed files"
						disabled={running}
						onClick={() => postMessage({ type: "keepChanges" })}
					>
						Keep
					</button>
					<button
						type="button"
						class="changes-button changes-undo"
						title="Undo all changed files"
						aria-label="Undo all changed files"
						disabled={running}
						onClick={() => postMessage({ type: "undoChanges" })}
					>
						Undo
					</button>
				</span>
			</div>
			{changes.notice ? <div class="changes-notice">{changes.notice}</div> : null}
			{expanded ? (
				<ul class="changes-list">
					{changes.files.map(file => (
						<li key={file.id} class="changes-row">
							<span
								class={`change-badge change-badge-${file.status}`}
								aria-label={STATUS_NAME[file.status]}
							>
								{STATUS_LETTER[file.status]}
							</span>
							<button
								type="button"
								class="change-path"
								title={file.path}
								onClick={() => postMessage({ type: "openChange", id: file.id })}
							>
								{file.path}
							</button>
							{file.additions !== undefined ? <span class="change-additions change-delta">+{file.additions}</span> : null}
							{file.deletions !== undefined ? <span class="change-deletions change-delta">−{file.deletions}</span> : null}
							<button
								type="button"
								class="change-file-action"
								title="Keep this file"
								aria-label={`Keep ${file.path}`}
								disabled={running}
								onClick={() => postMessage({ type: "keepChanges", ids: [file.id] })}
							>
								✓
							</button>
							<button
								type="button"
								class="change-file-action"
								title="Undo this file"
								aria-label={`Undo ${file.path}`}
								disabled={running}
								onClick={() => postMessage({ type: "undoChanges", ids: [file.id] })}
							>
								↶
							</button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
