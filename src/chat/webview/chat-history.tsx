import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ChatSessionActivity, ChatSessionActivityState, ChatSessionMeta } from "../shared/protocol";
import { formatAge, sessionGroup, type SessionGroup } from "./format";
import { matchesQuery, useDismiss, useKeepInView } from "./popup";

interface ChatHistoryProps {
	title: string;
	sessions: ChatSessionMeta[] | undefined;
	activeId: string | undefined;
	activity: ChatSessionActivity[];
	activeRunning: boolean;
	openRequest: number;
	onList: () => void;
	onOpen: (sessionId: string) => void;
	onDelete: (sessionId: string) => void;
	onRename: (sessionId: string, title: string) => void;
	onExport: (sessionId: string) => void;
	onNewChat: () => void;
}

interface HistoryEntry {
	session: ChatSessionMeta;
	index: number;
}

interface HistoryGroup {
	label: SessionGroup;
	entries: HistoryEntry[];
}

const STATUS_LABELS: Record<ChatSessionActivityState, string> = {
	running: "Running",
	approval: "Waiting for you",
	finished: "Finished",
};

const STATUS_GLYPHS: Record<ChatSessionActivityState, string> = {
	running: "●",
	approval: "!",
	finished: "✓",
};

const GROUP_ORDER: SessionGroup[] = ["Today", "Yesterday", "Last 7 days", "Older"];

export function ChatHistory({ title, sessions, activeId, activity, activeRunning, openRequest, onList, onOpen, onDelete, onRename, onExport, onNewChat }: ChatHistoryProps) {
	const instanceId = useId();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [renaming, setRenaming] = useState<string>();
	const renameRef = useRef<HTMLInputElement>(null);
	const editingRef = useRef<string | undefined>(undefined);
	useLayoutEffect(() => {
		if (renaming) {
			renameRef.current?.focus();
			renameRef.current?.select();
		}
	}, [renaming]);
	/** Enter and blur save, Escape cancels; the blur after either finds nothing left to save. */
	const finishRename = (save: boolean) => {
		const id = editingRef.current;
		if (!id) {
			return;
		}
		editingRef.current = undefined;
		if (save) {
			onRename(id, renameRef.current?.value ?? "");
		}
		setRenaming(undefined);
	};
	const [highlight, setHighlight] = useState(0);
	const [now, setNow] = useState(() => Date.now());
	const wrapperRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const lastRequest = useRef(openRequest);
	const close = useCallback(() => setOpen(false), []);
	const closeAndFocus = useCallback(() => {
		setOpen(false);
		triggerRef.current?.focus();
	}, []);
	useDismiss(wrapperRef, open, close);
	useKeepInView(popupRef, open);

	const groups = useMemo<HistoryGroup[]>(() => {
		const buckets = new Map<SessionGroup, ChatSessionMeta[]>();
		for (const session of sessions ?? []) {
			if (!matchesQuery(query, session.title)) {
				continue;
			}
			const label = sessionGroup(session.updatedAt, now);
			const bucket = buckets.get(label);
			if (bucket) {
				bucket.push(session);
			} else {
				buckets.set(label, [session]);
			}
		}
		const result: HistoryGroup[] = [];
		let index = 0;
		for (const label of GROUP_ORDER) {
			const bucket = buckets.get(label);
			if (!bucket) {
				continue;
			}
			result.push({
				label,
				entries: bucket.map(session => ({ session, index: index++ })),
			});
		}
		return result;
	}, [sessions, query, now]);

	const flat = useMemo(() => groups.flatMap(group => group.entries.map(entry => entry.session)), [groups]);
	const activityById = useMemo(() => {
		const states = new Map<string, ChatSessionActivityState>();
		for (const entry of activity) {
			states.set(entry.id, entry.state);
		}
		return states;
	}, [activity]);
	const listId = `${instanceId}-list`;
	const optionId = (index: number) => `${instanceId}-option-${index}`;
	const highlighted = flat[highlight];

	const openPopup = useCallback(() => {
		setQuery("");
		setNow(Date.now());
		onList();
		setOpen(true);
	}, [onList]);

	useEffect(() => {
		if (openRequest === lastRequest.current) {
			return;
		}
		lastRequest.current = openRequest;
		if (openRequest > 0) {
			openPopup();
		}
	}, [openRequest, openPopup]);

	useEffect(() => {
		if (open) {
			searchRef.current?.focus();
		}
	}, [open]);

	useLayoutEffect(() => {
		if (!open) {
			return;
		}
		const activeIndex = flat.findIndex(session => session.id === activeId);
		setHighlight(activeIndex >= 0 ? activeIndex : 0);
	}, [open, flat, activeId]);

	useEffect(() => {
		if (open) {
			document.getElementById(optionId(highlight))?.scrollIntoView({ block: "nearest" });
		}
	}, [open, highlight, flat]);

	const choose = (session: ChatSessionMeta) => {
		if (session.id !== activeId) {
			onOpen(session.id);
		}
		setOpen(false);
		triggerRef.current?.focus();
	};

	const createChat = () => {
		onNewChat();
		setOpen(false);
	};

	const moveHighlight = (delta: number) => {
		setHighlight(current => {
			if (flat.length === 0) {
				return 0;
			}
			const base = Math.min(Math.max(current, 0), flat.length - 1);
			return (base + delta + flat.length) % flat.length;
		});
	};

	const onPopupKeyDown = (event: KeyboardEvent) => {
		// List keys act only from the search box or the popup itself, not from a focused row button.
		const target = event.target;
		if (event.key !== "Escape" && target !== searchRef.current && target !== popupRef.current) {
			return;
		}
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				moveHighlight(1);
				break;
			case "ArrowUp":
				event.preventDefault();
				moveHighlight(-1);
				break;
			case "Enter":
				event.preventDefault();
				if (highlighted) {
					choose(highlighted);
				}
				break;
			case "Escape":
				event.preventDefault();
				closeAndFocus();
				break;
			case "Delete":
				if (query === "" && highlighted) {
					event.preventDefault();
					onDelete(highlighted.id);
				}
				break;
			default:
				break;
		}
	};

	return (
		<div class="history" ref={wrapperRef}>
			<button
				type="button"
				ref={triggerRef}
				class="history-trigger"
				aria-haspopup="dialog"
				aria-expanded={open}
				title="Show chats"
				onClick={() => (open ? setOpen(false) : openPopup())}
			>
				<span class="history-title">{title}</span>
				<span class="history-chevron" aria-hidden="true">▾</span>
			</button>
			{open ? (
				<div ref={popupRef} class="picker-popup history-popup picker-popup-below" role="dialog" aria-label="Chats" onKeyDown={onPopupKeyDown}>
					<div class="history-top">
						<input
							ref={searchRef}
							class="picker-search"
							type="text"
							placeholder="Search chats…"
							aria-label="Search chats"
							role="combobox"
							aria-expanded="true"
							aria-controls={listId}
							aria-autocomplete="list"
							aria-activedescendant={highlighted ? optionId(highlight) : undefined}
							value={query}
							onInput={event => setQuery(event.currentTarget.value)}
						/>
						<button type="button" class="history-new" onClick={createChat}>New chat</button>
					</div>
					<div id={listId} class="history-list" role="listbox" aria-label="Chats">
						{sessions === undefined ? (
							<div class="picker-empty">Loading…</div>
						) : flat.length === 0 ? (
							<div class="picker-empty">No chats match</div>
						) : (
							groups.map(group => (
								<div class="picker-group" role="group" aria-label={group.label} key={group.label}>
									<div class="picker-group-label">{group.label}</div>
									{group.entries.map(entry => {
										const active = entry.session.id === activeId;
										const selected = entry.index === highlight;
										const state = activityById.get(entry.session.id) ?? (active && activeRunning ? "running" : undefined);
										return (
											<div
												key={entry.session.id}
												id={optionId(entry.index)}
												class={`history-row${active ? " history-active" : ""}${selected ? " picker-option-active" : ""}`}
												role="option"
												aria-selected={selected}
												aria-current={active ? "true" : undefined}
											>
												{renaming === entry.session.id ? (
													<input
														ref={renameRef}
														class="history-rename-input"
														defaultValue={entry.session.title}
														aria-label="Chat title"
														onBlur={() => finishRename(true)}
														onKeyDown={event => {
															// Keys typed here belong to the title, not to the chat list.
															event.stopPropagation();
															if (event.key === "Enter" || event.key === "Escape") {
																event.preventDefault();
																finishRename(event.key === "Enter");
															}
														}}
													/>
												) : <button type="button" class="history-open" onClick={() => choose(entry.session)}>
													{state ? (
														<span class={`history-status history-status-${state}`} title={STATUS_LABELS[state]} aria-label={STATUS_LABELS[state]}>
															{STATUS_GLYPHS[state]}
														</span>
													) : (
														<span class="history-status" aria-hidden="true" />
													)}
													<span class="history-row-title">{entry.session.title}</span>
													<span class="history-row-age">{formatAge(entry.session.updatedAt, now)}</span>
												</button>}
												<button
													type="button"
													class="history-rename"
													aria-label={`Rename chat "${entry.session.title}"`}
													title="Rename"
													onClick={() => {
														editingRef.current = entry.session.id;
														setRenaming(entry.session.id);
													}}
												>
													✎
												</button>
												<button
													type="button"
													class="history-export"
													aria-label={`Export chat "${entry.session.title}" to Markdown`}
													title="Export to Markdown"
													onClick={() => onExport(entry.session.id)}
												>
													⤓
												</button>
												<button
													type="button"
													class="history-delete"
													aria-label={`Delete chat ${entry.session.title}`}
													title="Delete chat"
													onClick={() => onDelete(entry.session.id)}
												>
													×
												</button>
											</div>
										);
									})}
								</div>
							))
						)}
					</div>
				</div>
			) : null}
		</div>
	);
}
