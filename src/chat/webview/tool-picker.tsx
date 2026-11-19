import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ChatToolGroup, ChatToolInfo } from "../shared/protocol";
import { matchesQuery, popupPlacement, useDismiss, useKeepInView } from "./popup";

interface ToolPickerProps {
	tools: ChatToolGroup[];
	onSetToolsEnabled: (names: string[], enabled: boolean) => void;
}

interface VisibleToolGroup {
	group: ChatToolGroup;
	tools: ChatToolInfo[];
}

export function ToolPicker({ tools, onSetToolsEnabled }: ToolPickerProps) {
	const [open, setOpen] = useState(false);
	const [placement, setPlacement] = useState<"above" | "below">("above");
	const [query, setQuery] = useState("");
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

	const groups = useMemo<VisibleToolGroup[]>(
		() => tools
			.map(group => ({ group, tools: group.tools.filter(tool => matchesQuery(query, group.label, tool.name, tool.description)) }))
			.filter(entry => entry.tools.length > 0),
		[tools, query],
	);

	let enabledTotal = 0;
	let total = 0;
	for (const group of tools) {
		for (const tool of group.tools) {
			total += 1;
			if (tool.enabled) {
				enabledTotal += 1;
			}
		}
	}

	useEffect(() => {
		if (open) {
			searchRef.current?.focus();
		}
	}, [open]);

	const openPopup = () => {
		setQuery("");
		setPlacement(popupPlacement(triggerRef.current));
		setOpen(true);
	};

	const setTools = (names: string[], enabled: boolean) => {
		if (names.length > 0) {
			onSetToolsEnabled(names, enabled);
		}
	};

	const toggleGroup = (group: ChatToolGroup, visible: ChatToolInfo[]) => {
		const allEnabled = visible.length > 0 && visible.every(tool => tool.enabled);
		setTools(visible.map(tool => tool.name), !allEnabled);
	};

	const onPopupKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Escape") {
			return;
		}
		event.preventDefault();
		closeAndFocus();
	};

	return (
		<div class="picker tool-picker" ref={wrapperRef}>
			<button
				type="button"
				ref={triggerRef}
				class="picker-trigger"
				aria-expanded={open}
				title="Choose which tools the model can use"
				onClick={() => (open ? setOpen(false) : openPopup())}
			>
				<span class="picker-trigger-name">Tools {enabledTotal}/{total}</span>
			</button>
			{open ? (
				<div ref={popupRef} class={`picker-popup tool-popup picker-popup-${placement}`} onKeyDown={onPopupKeyDown}>
					<input
						ref={searchRef}
						class="picker-search"
						type="text"
						placeholder="Search tools…"
						aria-label="Search tools"
						value={query}
						onInput={event => setQuery(event.currentTarget.value)}
					/>
					<div class="picker-list">
						{groups.map(entry => {
							const enabledCount = entry.tools.filter(tool => tool.enabled).length;
							const allEnabled = enabledCount === entry.tools.length && entry.tools.length > 0;
							const someEnabled = enabledCount > 0 && !allEnabled;
							return (
								<div class="tool-group" role="group" aria-label={entry.group.label} key={entry.group.id}>
									<div class="tool-group-head">
										<input
											type="checkbox"
											class="tool-check"
											checked={allEnabled}
											aria-label={`${entry.group.label}: toggle visible tools`}
											ref={element => {
												if (element) {
													element.indeterminate = someEnabled;
												}
											}}
											onChange={() => toggleGroup(entry.group, entry.tools)}
										/>
										<span class="tool-group-label">{entry.group.label}</span>
										<span class="tool-group-count">{enabledCount}/{entry.tools.length}</span>
									</div>
									{entry.group.note ? <div class="tool-group-note">{entry.group.note}</div> : null}
									{entry.tools.map(tool => (
										<label class="tool-row" title={tool.description} key={tool.name}>
											<input
												type="checkbox"
												class="tool-check"
												checked={tool.enabled}
												onChange={() => setTools([tool.name], !tool.enabled)}
											/>
											<span class="tool-row-name">{tool.name}</span>
											<span class="tool-row-desc">{tool.description}</span>
										</label>
									))}
								</div>
							);
						})}
						{groups.length === 0 ? <div class="picker-empty">No tools match</div> : null}
					</div>
				</div>
			) : null}
		</div>
	);
}
