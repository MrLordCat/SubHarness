import { useCallback, useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import {
	CHAT_MEMORY_CONTENT_MAX_CHARS,
	CHAT_MEMORY_TITLE_MAX_CHARS,
	ChatMemoryKinds,
	type ChatMemoryEntry,
} from "../shared/protocol";
import { postMessage } from "./api";
import { formatAge } from "./format";
import { matchesQuery, useDismiss, useKeepInView } from "./popup";
import type { ChatStore } from "./store";

interface MemoryPanelProps {
	memory: ChatStore["memory"];
	onList: () => void;
}

type ScopeFilter = "all" | "workspace" | "global";

interface MemoryDraft {
	id?: string;
	title: string;
	content: string;
	kind: string;
	scope: "global" | "workspace";
	pinned: boolean;
}

const SCOPE_LABELS: Array<{ value: ScopeFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "workspace", label: "Project" },
	{ value: "global", label: "Global" },
];

function MemoryIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			<path
				fill="none"
				stroke="currentColor"
				stroke-width="1.2"
				stroke-linejoin="round"
				d="M2.6 3.1c1.8-.6 3.6-.6 5.4.5v9c-1.8-1.1-3.6-1.1-5.4-.5v-9zM13.4 3.1c-1.8-.6-3.6-.6-5.4.5v9c1.8-1.1 3.6-1.1 5.4-.5v-9z"
			/>
		</svg>
	);
}

export function MemoryPanel({ memory, onList }: MemoryPanelProps) {
	const instanceId = useId();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<ScopeFilter>("all");
	const [expandedId, setExpandedId] = useState<string | undefined>(undefined);
	const [confirmId, setConfirmId] = useState<string | undefined>(undefined);
	const [draft, setDraft] = useState<MemoryDraft | undefined>(undefined);
	const [now, setNow] = useState(() => Date.now());
	const wrapperRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const close = useCallback(() => setOpen(false), []);
	const closeAndFocus = useCallback(() => {
		setOpen(false);
		triggerRef.current?.focus();
	}, []);
	useDismiss(wrapperRef, open, close);
	useKeepInView(popupRef, open);

	const openPopup = () => {
		setQuery("");
		setNow(Date.now());
		setDraft(undefined);
		setExpandedId(undefined);
		setConfirmId(undefined);
		onList();
		setOpen(true);
	};

	const closeDraft = useCallback(() => setDraft(undefined), []);

	useEffect(() => {
		if (open) {
			searchRef.current?.focus();
		}
	}, [open]);

	const visible = useMemo(() => memory.entries.filter(entry => {
		if (scope === "workspace" && entry.scope !== "workspace") {
			return false;
		}
		if (scope === "global" && entry.scope !== "global") {
			return false;
		}
		return matchesQuery(query, entry.title, entry.content, entry.kind, entry.tags.join(" "));
	}), [memory.entries, query, scope]);

	const startNew = () => {
		setExpandedId(undefined);
		setConfirmId(undefined);
		setDraft({
			title: "",
			content: "",
			kind: "other",
			scope: memory.projectLabel === undefined ? "global" : "workspace",
			pinned: false,
		});
	};

	const startEdit = (entry: ChatMemoryEntry) => {
		setConfirmId(undefined);
		setDraft({
			id: entry.id,
			title: entry.title,
			content: entry.content,
			kind: entry.kind,
			scope: entry.scope,
			pinned: entry.pinned,
		});
	};

	const toggleExpanded = (id: string) => {
		setConfirmId(undefined);
		setDraft(undefined);
		setExpandedId(current => current === id ? undefined : id);
	};

	const submit = useCallback((current: MemoryDraft | undefined) => {
		if (!current || !current.title.trim() || !current.content.trim()) {
			return;
		}
		postMessage({
			type: "saveMemory",
			entry: {
				...(current.id === undefined ? {} : { id: current.id }),
				title: current.title.trim(),
				content: current.content.trim(),
				kind: current.kind,
				scope: current.scope,
				pinned: current.pinned,
			},
		});
		setDraft(undefined);
		setExpandedId(undefined);
	}, []);

	const togglePin = (entry: ChatMemoryEntry) => {
		postMessage({
			type: "saveMemory",
			entry: {
				id: entry.id,
				title: entry.title,
				content: entry.content,
				kind: entry.kind,
				scope: entry.scope,
				pinned: !entry.pinned,
			},
		});
	};

	const remove = (id: string) => {
		postMessage({ type: "deleteMemory", id });
		setConfirmId(undefined);
		setExpandedId(undefined);
	};

	const updateDraft = (patch: Partial<MemoryDraft>) => {
		setDraft(current => current ? { ...current, ...patch } : current);
	};

	const onPopupKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Escape") {
			return;
		}
		event.preventDefault();
		closeAndFocus();
	};

	const renderDraft = (current: MemoryDraft) => (
		<form
			class="memory-form"
			onSubmit={event => {
				event.preventDefault();
				submit(current);
			}}
			onKeyDown={event => {
				if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
					event.preventDefault();
					submit(current);
				}
			}}
		>
			<label class="memory-field">
				<span class="memory-field-label">Title</span>
				<input
					class="memory-input"
					type="text"
					maxLength={CHAT_MEMORY_TITLE_MAX_CHARS}
					value={current.title}
					onInput={event => updateDraft({ title: event.currentTarget.value })}
				/>
			</label>
			<div class="memory-form-row">
				<label class="memory-field">
					<span class="memory-field-label">Kind</span>
					<select
						class="memory-select"
						value={current.kind}
						onChange={event => updateDraft({ kind: event.currentTarget.value })}
					>
						{ChatMemoryKinds
							// externalFact needs a source and a verification date the form cannot set; offered only to entries that have them.
							.filter(kind => kind !== "externalFact" || memory.entries.some(entry => entry.id === current.id && entry.kind === kind))
							.map(kind => <option value={kind} key={kind}>{kind}</option>)}
					</select>
				</label>
				<label class="memory-field">
					<span class="memory-field-label">Scope</span>
					<select
						class="memory-select"
						value={current.scope}
						disabled={current.id !== undefined}
						onChange={event => updateDraft({ scope: event.currentTarget.value === "workspace" ? "workspace" : "global" })}
					>
						<option value="workspace">Project</option>
						<option value="global">Global</option>
					</select>
				</label>
				<label class="memory-check">
					<input
						type="checkbox"
						checked={current.pinned}
						onChange={event => updateDraft({ pinned: event.currentTarget.checked })}
					/>
					Pinned
				</label>
			</div>
			<label class="memory-field">
				<span class="memory-field-label">Content</span>
				<textarea
					class="memory-textarea"
					rows={8}
					maxLength={CHAT_MEMORY_CONTENT_MAX_CHARS}
					value={current.content}
					onInput={event => updateDraft({ content: event.currentTarget.value })}
				/>
			</label>
			<div class="memory-actions">
				<button type="submit" class="memory-save" disabled={!current.title.trim() || !current.content.trim()}>Save</button>
				<button type="button" class="memory-action" onClick={closeDraft}>Cancel</button>
			</div>
		</form>
	);

	const renderEntry = (entry: ChatMemoryEntry) => {
		const expanded = expandedId === entry.id;
		const editing = expanded && draft?.id === entry.id;
		return (
			<li class={`memory-entry${entry.expired ? " memory-entry-expired" : ""}`} key={entry.id}>
				<button
					type="button"
					class="memory-row"
					aria-expanded={expanded}
					aria-controls={expanded && !editing ? `${instanceId}-body-${entry.id}` : undefined}
					onClick={() => toggleExpanded(entry.id)}
				>
					{entry.pinned ? <span class="memory-pin" aria-hidden="true">📌</span> : null}
					<span class="memory-title">{entry.title}</span>
					<span class="memory-meta">{entry.scope === "workspace" ? "project" : "global"} · {entry.kind}</span>
					{entry.expired ? <span class="memory-expired">expired</span> : null}
					<span class="memory-age">{formatAge(entry.updatedAt, now)}</span>
				</button>
				{editing && draft ? renderDraft(draft) : expanded ? (
					<div class="memory-body" id={`${instanceId}-body-${entry.id}`}>
						<pre class="memory-content">{entry.content}</pre>
						<div class="memory-actions">
							{confirmId === entry.id ? (
								<>
									<span class="memory-confirm">Delete?</span>
									<button type="button" class="memory-action memory-danger" onClick={() => remove(entry.id)}>Yes</button>
									<button type="button" class="memory-action" onClick={() => setConfirmId(undefined)}>No</button>
								</>
							) : (
								<>
									<button type="button" class="memory-action" onClick={() => startEdit(entry)}>Edit</button>
									<button type="button" class="memory-action" onClick={() => togglePin(entry)}>{entry.pinned ? "Unpin" : "Pin"}</button>
									<button type="button" class="memory-action memory-danger" onClick={() => setConfirmId(entry.id)}>Delete</button>
								</>
							)}
						</div>
					</div>
				) : null}
			</li>
		);
	};

	return (
		<div class="memory" ref={wrapperRef}>
			<button
				type="button"
				ref={triggerRef}
				class="memory-trigger"
				aria-label="Memory"
				title="Shared memory"
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => (open ? close() : openPopup())}
			>
				<MemoryIcon />
			</button>
			{open ? (
				<div ref={popupRef} class="picker-popup memory-popup" role="dialog" aria-label="Shared memory" onKeyDown={onPopupKeyDown}>
					<div class="memory-top">
						<input
							ref={searchRef}
							class="picker-search"
							type="text"
							placeholder="Search memory…"
							aria-label="Search memory"
							value={query}
							onInput={event => setQuery(event.currentTarget.value)}
						/>
						<button type="button" class="memory-new" onClick={startNew}>New</button>
					</div>
					<div class="memory-filters" role="group" aria-label="Filter by scope">
						{SCOPE_LABELS.map(option => {
							if (option.value === "workspace" && memory.projectLabel === undefined) {
								return null;
							}
							return (
								<button
									type="button"
									key={option.value}
									class={`memory-filter${scope === option.value ? " memory-filter-active" : ""}`}
									aria-pressed={scope === option.value}
									onClick={() => setScope(option.value)}
								>
									{option.label}
								</button>
							);
						})}
					</div>
					{memory.enabled ? null : <div class="memory-note">Memory is turned off in settings (llamacpp.memoryEnabled).</div>}
					{memory.notice ? <div class="memory-notice" role="alert">{memory.notice}</div> : null}
					{draft && draft.id === undefined ? renderDraft(draft) : null}
					{!memory.loaded ? (
						<div class="memory-empty">Loading…</div>
					) : memory.entries.length === 0 ? (
						<div class="memory-empty">No memory entries yet. The agent saves durable facts here; you can add one with New.</div>
					) : visible.length === 0 ? (
						<div class="memory-empty">No entries match.</div>
					) : (
						<ul class="memory-list" aria-label="Memory entries">
							{visible.map(renderEntry)}
						</ul>
					)}
				</div>
			) : null}
		</div>
	);
}
