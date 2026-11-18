import { useEffect } from "preact/hooks";

/** Closes the popup when a pointer goes down outside of `target`. */
export function useDismiss(target: { current: HTMLElement | null }, open: boolean, onClose: () => void): void {
	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (event: PointerEvent) => {
			const node = event.target;
			if (node instanceof Node && target.current?.contains(node)) {
				return;
			}
			onClose();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => document.removeEventListener("pointerdown", onPointerDown, true);
	}, [open, onClose, target]);
}

const POPUP_ROOM = 320;

/** Opens upwards unless the scroll area (or window) leaves too little room above the trigger. */
export function popupPlacement(trigger: HTMLElement | null): "above" | "below" {
	if (!trigger) {
		return "above";
	}
	const box = trigger.getBoundingClientRect();
	const bounds = trigger.closest(".message-scroller")?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
	const above = box.top - bounds.top;
	const below = bounds.bottom - box.bottom;
	return above < POPUP_ROOM && below > above ? "below" : "above";
}

/** Every whitespace-separated token must appear somewhere in the joined fields. */
export function matchesQuery(query: string, ...fields: string[]): boolean {
	const tokens = query.toLowerCase().split(/\s+/).filter(token => token.length > 0);
	if (tokens.length === 0) {
		return true;
	}
	const haystack = fields.join(" ").toLowerCase();
	return tokens.every(token => haystack.includes(token));
}
