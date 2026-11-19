import { useCallback, useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import type { ChatThinkingOptions } from "../shared/protocol";
import { popupPlacement, useDismiss, useKeepInView } from "./popup";

interface ThinkingPickerProps {
	thinking: ChatThinkingOptions;
	selected: string | undefined;
	onSelect: (value: string) => void;
}

export function ThinkingPicker({ thinking, selected, onSelect }: ThinkingPickerProps) {
	const instanceId = useId();
	const [open, setOpen] = useState(false);
	const [placement, setPlacement] = useState<"above" | "below">("above");
	const [highlight, setHighlight] = useState(0);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const close = useCallback(() => setOpen(false), []);
	const closeAndFocus = useCallback(() => {
		setOpen(false);
		triggerRef.current?.focus();
	}, []);
	useDismiss(wrapperRef, open, close);
	useKeepInView(popupRef, open);

	const effective = selected ?? thinking.default;
	const selectedIndex = useMemo(
		() => thinking.levels.findIndex(level => level.value === effective),
		[thinking, effective],
	);
	const activeLabel = (selectedIndex >= 0 ? thinking.levels[selectedIndex] : undefined)?.label ?? "Thinking";
	const optionId = (index: number) => `${instanceId}-option-${index}`;

	useEffect(() => {
		if (open) {
			popupRef.current?.focus();
		}
	}, [open]);

	useEffect(() => {
		if (open) {
			document.getElementById(optionId(highlight))?.scrollIntoView({ block: "nearest" });
		}
	}, [open, highlight]);

	const openPopup = () => {
		setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
		setPlacement(popupPlacement(triggerRef.current));
		setOpen(true);
	};

	const choose = (value: string) => {
		onSelect(value);
		setOpen(false);
		triggerRef.current?.focus();
	};

	const moveHighlight = (delta: number) => {
		const count = thinking.levels.length;
		if (count === 0) {
			return;
		}
		setHighlight(current => (Math.min(Math.max(current, 0), count - 1) + delta + count) % count);
	};

	const onPopupKeyDown = (event: KeyboardEvent) => {
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
				const level = thinking.levels[highlight];
				if (level) {
					choose(level.value);
				}
				break;
			}
			case "Escape":
				event.preventDefault();
				closeAndFocus();
				break;
			case "Tab":
				setOpen(false);
				break;
			default:
				break;
		}
	};

	return (
		<div class="picker thinking-picker" ref={wrapperRef}>
			<button
				type="button"
				ref={triggerRef}
				class="picker-trigger"
				aria-haspopup="listbox"
				aria-expanded={open}
				title={selectedIndex >= 0 ? `Thinking: ${thinking.levels[selectedIndex].label}` : "Thinking: Default"}
				onClick={() => (open ? setOpen(false) : openPopup())}
			>
				<span class="picker-trigger-name">{activeLabel}</span>
			</button>
			{open ? (
				<div
					ref={popupRef}
					class={`picker-popup thinking-popup picker-popup-${placement}`}
					role="listbox"
					aria-label="Thinking level"
					tabIndex={-1}
					onKeyDown={onPopupKeyDown}
				>
					{thinking.levels.map((level, index) => (
						<div
							key={level.value}
							id={optionId(index)}
							class={`picker-option thinking-option${index === highlight ? " picker-option-active" : ""}`}
							role="option"
							aria-selected={level.value === effective}
							onClick={() => choose(level.value)}
						>
							<span class="thinking-option-text">
								<span class="thinking-option-label">{level.label}</span>
								{level.description ? <span class="thinking-option-desc">{level.description}</span> : null}
							</span>
							<span class="picker-option-check" aria-hidden="true">{level.value === effective ? "✓" : ""}</span>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
