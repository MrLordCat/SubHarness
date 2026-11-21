import { useCallback, useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import type { ChatModelEntry, ChatModelGroup, ChatProviderQuota, ChatSignInOffer } from "../shared/protocol";
import { OPEN_MODEL_PICKER_EVENT } from "./events";
import { exhaustedWindow, formatQuotaExhausted, formatQuotaSummary, formatQuotaTitle, quotaSeverity } from "./format";
import { matchesQuery, popupPlacement, useDismiss, useKeepInView } from "./popup";

interface ModelPickerProps {
	models: ChatModelGroup[];
	selectedModelId: string | undefined;
	quota?: ChatProviderQuota[];
	onRefreshQuota?: () => void;
	onSelectModel: (modelId: string) => void;
	/** Starred model ids; when one is available the picker opens on them. */
	favorites?: string[];
	onSetFavorite?: (modelId: string, favorite: boolean) => void;
	/** Subscriptions to sign in to, listed below the models. */
	signIn?: ChatSignInOffer[];
	onSignIn?: (provider: string) => void;
}

interface VisibleModel {
	model: ChatModelEntry;
	index: number;
}

interface VisibleGroup {
	provider: string;
	models: VisibleModel[];
}

/** The models that match the query, grouped by provider; `only` keeps just those ids. */
function visibleGroups(models: readonly ChatModelGroup[], query: string, only: ReadonlySet<string> | undefined): VisibleGroup[] {
	const result: VisibleGroup[] = [];
	let index = 0;
	for (const group of models) {
		const visible: VisibleModel[] = [];
		for (const model of group.models) {
			if ((only && !only.has(model.id)) || !matchesQuery(query, group.provider, model.name, model.id)) {
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
}

/** The favorites view: the starred models that are available, and the selected one; undefined when none is starred. */
function favoritesFilter(models: readonly ChatModelGroup[], favorites: ReadonlySet<string>, selectedModelId: string | undefined): ReadonlySet<string> | undefined {
	if (!models.some(group => group.models.some(model => favorites.has(model.id)))) {
		return undefined;
	}
	return selectedModelId === undefined ? favorites : new Set([...favorites, selectedModelId]);
}

export function ModelPicker({ models, selectedModelId, quota, onRefreshQuota, onSelectModel, favorites, onSetFavorite, signIn, onSignIn }: ModelPickerProps) {
	const instanceId = useId();
	const [open, setOpen] = useState(false);
	const [placement, setPlacement] = useState<"above" | "below">("above");
	const [query, setQuery] = useState("");
	const [highlight, setHighlight] = useState(0);
	const [showAll, setShowAll] = useState(false);
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

	const favoriteSet = useMemo(() => new Set(favorites ?? []), [favorites]);
	const favoritesOnly = useMemo(() => favoritesFilter(models, favoriteSet, selectedModelId), [models, favoriteSet, selectedModelId]);
	// The picker opens on the favorites; a search or "Show all models" lists every model.
	const only = !showAll && !query ? favoritesOnly : undefined;
	const groups = useMemo<VisibleGroup[]>(() => visibleGroups(models, query, only), [models, query, only]);
	const total = useMemo(() => models.reduce((count, group) => count + group.models.length, 0), [models]);

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
		const entries = visibleGroups(models, "", favoritesOnly).flatMap(group => group.models.map(entry => entry.model));
		const selectedIndex = entries.findIndex(model => model.id === selectedModelId);
		setQuery("");
		setShowAll(false);
		setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
		setPlacement(popupPlacement(triggerRef.current));
		setOpen(true);
		onRefreshQuota?.();
	};

	useEffect(() => {
		const openFromNotice = () => openPopup();
		window.addEventListener(OPEN_MODEL_PICKER_EVENT, openFromNotice);
		return () => window.removeEventListener(OPEN_MODEL_PICKER_EVENT, openFromNotice);
	}, [models, selectedModelId, onRefreshQuota, favoritesOnly]);

	/** Switches between the favorites and every model, keeping the selected model highlighted. */
	const toggleShowAll = () => {
		const next = !showAll;
		const entries = visibleGroups(models, "", next ? undefined : favoritesOnly).flatMap(group => group.models.map(entry => entry.model));
		const selectedIndex = entries.findIndex(model => model.id === selectedModelId);
		setShowAll(next);
		setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
		searchRef.current?.focus();
	};

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
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
			const entry = flat[highlight];
			if (entry && onSetFavorite) {
				event.preventDefault();
				onSetFavorite(entry.id, !favoriteSet.has(entry.id));
			}
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
			case "Enter": {
				event.preventDefault();
				const entry = flat[highlight];
				if (entry) {
					choose(entry.id);
				}
				break;
			}
			default:
				break;
		}
	};

	const onPopupKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			closeAndFocus();
			return;
		}
		if (event.key !== "Tab") {
			return;
		}
		// Tab and Shift+Tab wrap inside the open list, so the stars stay reachable without closing it.
		const focusable = Array.from(popupRef.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled), [tabindex]") ?? [])
			.filter(element => element.tabIndex >= 0 && element.offsetParent !== null);
		if (focusable.length === 0) {
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && (document.activeElement === first || !popupRef.current?.contains(document.activeElement))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (document.activeElement === last || !popupRef.current?.contains(document.activeElement))) {
			event.preventDefault();
			first.focus();
		}
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
							const now = Date.now();
							const summary = quotaEntry ? formatQuotaSummary(quotaEntry, now) : "";
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
											? <span class={`picker-group-quota quota-${quotaSeverity(quotaEntry, now)}`} title={formatQuotaTitle(quotaEntry)}>{summary}</span>
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
											{onSetFavorite ? (
												<FavoriteStar
													name={entry.model.name}
													favorite={favoriteSet.has(entry.model.id)}
													onToggle={favorite => onSetFavorite(entry.model.id, favorite)}
												/>
											) : null}
											<span class="picker-option-check" aria-hidden="true">{entry.model.id === selectedModelId ? "✓" : ""}</span>
										</div>
									))}
								</div>
							);
						})}
						{flat.length === 0 ? <div class="picker-empty">No models match</div> : null}
					</div>
					{favoritesOnly && !query ? (
						<button
							type="button"
							class="picker-show-all"
							// Keeps the focus, and with it the arrow keys, in the search field.
							onMouseDown={event => event.preventDefault()}
							onClick={toggleShowAll}
						>
							{showAll ? "Show favorites only" : `Show all models (${total})`}
						</button>
					) : null}
					{!favoritesOnly && onSetFavorite && !query ? (
						<div class="picker-hint">Star models with ☆ and the picker opens on them.</div>
					) : null}
					{signIn && signIn.length > 0 && onSignIn ? (
						<div class="picker-signin">
							{signIn.map(offer => (
								<button
									type="button"
									key={offer.provider}
									class="picker-signin-button"
									title={offer.detail}
									onClick={() => {
										setOpen(false);
										onSignIn(offer.provider);
									}}
								>
									{offer.label}
								</button>
							))}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

interface FavoriteStarProps {
	name: string;
	favorite: boolean;
	onToggle: (favorite: boolean) => void;
}

/** The star of a model row: a click stars or unstars the model without choosing it. */
function FavoriteStar({ name, favorite, onToggle }: FavoriteStarProps) {
	return (
		<button
			type="button"
			tabIndex={0}
			class={`picker-option-star${favorite ? " picker-option-star-on" : ""}`}
			aria-pressed={favorite}
			aria-label={favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
			title={favorite ? "Remove from favorites (Ctrl+D)" : "Add to favorites (Ctrl+D)"}
			// Keeps the focus, and with it the arrow keys, in the search field.
			onMouseDown={event => event.preventDefault()}
			onClick={event => {
				event.stopPropagation();
				onToggle(!favorite);
			}}
		>
			{favorite ? "★" : "☆"}
		</button>
	);
}
