import { useCallback, useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import type { ChatModelEntry, ChatModelGroup, ChatProviderQuota } from "../shared/protocol";
import { OPEN_MODEL_PICKER_EVENT } from "./events";
import { exhaustedWindow, formatQuotaExhausted, formatQuotaSummary, formatQuotaTitle, quotaSeverity } from "./format";
import { matchesQuery, popupPlacement, useDismiss, useKeepInView } from "./popup";

interface ModelPickerProps {
	models: ChatModelGroup[];
	selectedModelId: string | undefined;
	quota?: ChatProviderQuota[];
	onRefreshQuota?: () => void;
	onSelectModel: (modelId: string) => void;
}

interface VisibleModel {
	model: ChatModelEntry;
	index: number;
}

interface VisibleGroup {
	provider: string;
	models: VisibleModel[];
}

export function ModelPicker({ models, selectedModelId, quota, onRefreshQuota, onSelectModel }: ModelPickerProps) {
	const instanceId = useId();
	const [open, setOpen] = useState(false);
	const [placement, setPlacement] = useState<"above" | "below">("above");
	const [query, setQuery] = useState("");
	const [highlight, setHighlight] = useState(0);
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

	const groups = useMemo<VisibleGroup[]>(() => {
		const result: VisibleGroup[] = [];
		let index = 0;
		for (const group of models) {
			const visible: VisibleModel[] = [];
			for (const model of group.models) {
				if (!matchesQuery(query, group.provider, model.name, model.id)) {
					continue;
				}
				visible.push({ model, index });
				index += 1;
			}
			if (visible.length > 0) {
				result.push({ provider: group.provider, models: visible });
			}
		}
		return result;
	}, [models, query]);

	const flat = useMemo(() => groups.flatMap(group => group.models.map(entry => entry.model)), [groups]);

	const selected = useMemo(() => {
		for (const group of models) {
			const model = group.models.find(candidate => candidate.id === selectedModelId);
			if (model) {
				return { model, provider: group.provider };
			}
		}
		return undefined;
	}, [models, selectedModelId]);

	const listId = `${instanceId}-list`;
	const optionId = (index: number) => `${instanceId}-option-${index}`;
	const active = flat[highlight];

	useEffect(() => {
		if (open) {
			searchRef.current?.focus();
		}
	}, [open]);

	useEffect(() => {
		if (open && active) {
			document.getElementById(optionId(highlight))?.scrollIntoView({ block: "nearest" });
		}
	}, [open, active, highlight]);

	const openPopup = () => {
		const entries = models.flatMap(group => group.models);
		const selectedIndex = entries.findIndex(model => model.id === selectedModelId);
		setQuery("");
		setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
		setPlacement(popupPlacement(triggerRef.current));
		setOpen(true);
		onRefreshQuota?.();
	};

	useEffect(() => {
		const openFromNotice = () => openPopup();
		window.addEventListener(OPEN_MODEL_PICKER_EVENT, openFromNotice);
		return () => window.removeEventListener(OPEN_MODEL_PICKER_EVENT, openFromNotice);
	}, [models, selectedModelId, onRefreshQuota]);

	const choose = (modelId: string) => {
		onSelectModel(modelId);
		setOpen(false);
		triggerRef.current?.focus();
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

	const onSearchKeyDown = (event: KeyboardEvent) => {
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				moveHighlight(1);
				break;
			case "ArrowUp":
				event.preventDefault();
				moveHighlight(-1);
				break;
			case "Enter": {
				event.preventDefault();
				const entry = flat[highlight];
				if (entry) {
					choose(entry.id);
				}
				break;
			}
			case "Tab":
				setOpen(false);
				break;
			default:
				break;
		}
	};

	const onPopupKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Escape") {
			return;
		}
		event.preventDefault();
		closeAndFocus();
	};

	return (
		<div class="picker model-picker" ref={wrapperRef}>
			<button
				type="button"
				ref={triggerRef}
				class="picker-trigger"
				aria-haspopup="listbox"
				aria-expanded={open}
				title={selected ? `${selected.model.name} · ${selected.provider}` : "Select model"}
				onClick={() => (open ? setOpen(false) : openPopup())}
			>
				<span class="picker-trigger-name">{selected?.model.name ?? "Select model"}</span>
				{selected ? <span class="picker-trigger-provider">· {selected.provider}</span> : null}
			</button>
			{open ? (
				<div ref={popupRef} class={`picker-popup model-popup picker-popup-${placement}`} onKeyDown={onPopupKeyDown}>
					<input
						ref={searchRef}
						class="picker-search"
						type="text"
						placeholder="Search models…"
						aria-label="Search models"
						role="combobox"
						aria-expanded="true"
						aria-controls={listId}
						aria-autocomplete="list"
						aria-activedescendant={active ? optionId(highlight) : undefined}
						value={query}
						onInput={event => setQuery(event.currentTarget.value)}
						onKeyDown={onSearchKeyDown}
					/>
					<div id={listId} class="picker-list" role="listbox" aria-label="Models">
						{groups.map(group => {
							const quotaEntry = quota?.find(candidate => candidate.provider === group.provider);
							const summary = quotaEntry ? formatQuotaSummary(quotaEntry) : "";
							const now = Date.now();
							const exhausted = quotaEntry ? exhaustedWindow(quotaEntry, now) : undefined;
							const note = quotaEntry && exhausted ? formatQuotaExhausted(quotaEntry, now) : undefined;
							return (
								<div
									class={`picker-group${exhausted ? " picker-group-exhausted" : ""}`}
									role="group"
									aria-label={group.provider}
									key={group.provider}
								>
									<div class="picker-group-label">
										<span class="picker-group-name">{group.provider}</span>
										{quotaEntry && summary
											? <span class={`picker-group-quota quota-${quotaSeverity(quotaEntry)}`} title={formatQuotaTitle(quotaEntry)}>{summary}</span>
											: null}
									</div>
									{note ? <div class="picker-group-note">{note}</div> : null}
									{group.models.map(entry => (
										<div
											key={entry.model.id}
											id={optionId(entry.index)}
											class={`picker-option${entry.index === highlight ? " picker-option-active" : ""}`}
											role="option"
											aria-selected={entry.model.id === selectedModelId}
											onClick={() => choose(entry.model.id)}
										>
											<span class="picker-option-name">{entry.model.name}</span>
											<span class="picker-option-check" aria-hidden="true">{entry.model.id === selectedModelId ? "✓" : ""}</span>
										</div>
									))}
								</div>
							);
						})}
						{flat.length === 0 ? <div class="picker-empty">No models match</div> : null}
					</div>
				</div>
			) : null}
		</div>
	);
}
