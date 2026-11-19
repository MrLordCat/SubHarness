import { useEffect, useLayoutEffect } from "preact/hooks";

/** Closes the popup when a pointer goes down outside of `target` or keyboard focus leaves it. */
export function useDismiss(target: { current: HTMLElement | null }, open: boolean, onClose: () => void): void {
	useEffect(() => {
		if (!open) {
			return;
		}
		const wrapper = target.current;
		const onPointerDown = (event: PointerEvent) => {
			const node = event.target;
			if (node instanceof Node && wrapper?.contains(node)) {
				return;
			}
			onClose();
		};
		const onFocusOut = (event: FocusEvent) => {
			const next = event.relatedTarget;
			// A null relatedTarget means the window itself lost focus; an outside element means the popup is done.
			if (next === null || (next instanceof Node && wrapper?.contains(next))) {
				return;
			}
			onClose();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		wrapper?.addEventListener("focusout", onFocusOut);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			wrapper?.removeEventListener("focusout", onFocusOut);
		};
	}, [open, onClose, target]);
}

const VIEWPORT_MARGIN = 4;

/** Shifts an open popup horizontally so it stays inside the window. */
export function useKeepInView(popup: { current: HTMLElement | null }, open: boolean): void {
	useLayoutEffect(() => {
		if (!open) {
			return;
		}
		const fit = () => {
			const node = popup.current;
			if (!node) {
				return;
			}
			node.style.transform = "";
			const box = node.getBoundingClientRect();
			const limit = document.documentElement.clientWidth - VIEWPORT_MARGIN;
			let shift = box.right > limit ? limit - box.right : 0;
			if (box.left + shift < VIEWPORT_MARGIN) {
				shift = VIEWPORT_MARGIN - box.left;
			}
			if (shift !== 0) {
				node.style.transform = `translateX(${Math.round(shift)}px)`;
			}
		};
		fit();
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, [open, popup]);
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
