import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ChatMessage } from "../shared/protocol";
import { VirtualLayout } from "../shared/virtual-layout";
import { MessageItem } from "./message";
import type { ChatStore } from "./store";

const ESTIMATED_HEIGHT = 80;
const OVERSCAN = 800;
const STICK_THRESHOLD = 40;
// Each scroll correction can change the rendered range; past this, wait a frame so the ResizeObserver measures first.
const MAX_SYNC_SCROLL_PASSES = 4;
const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

interface MessageListProps {
	store: ChatStore;
	running: boolean;
	context: string | undefined;
}

/** The newest compaction decides where the "summarized" divider goes. */
function compactionBoundaryId(messages: ChatMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const parts = messages[index].parts;
		for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
			const part = parts[partIndex];
			if (part.kind === "compaction") {
				return part.keepFromMessageId;
			}
		}
	}
	return undefined;
}

export function MessageList({ store, running, context }: MessageListProps) {
	const scrollerRef = useRef<HTMLDivElement>(null);
	const observerRef = useRef<ResizeObserver | null>(null);
	const observedRef = useRef(new Set<Element>());
	const layoutRef = useRef<VirtualLayout | null>(null);
	const sourceRef = useRef<ChatMessage[] | null>(null);
	const stickRef = useRef(true);
	const lastTopRef = useRef(0);
	const shiftRef = useRef(0);
	const frameRef = useRef(0);
	const passesRef = useRef(0);
	const passesFrameRef = useRef(0);
	const [viewportHeight, setViewportHeight] = useState(0);
	const [scrollTop, setScrollTop] = useState(0);
	const [away, setAway] = useState(false);
	const [hasNew, setHasNew] = useState(false);
	const latestRef = useRef<{ source: ChatMessage[]; count: number; id: string | undefined; text: string } | undefined>(undefined);
	const [, setRevision] = useState(0);

	// A starting run closes the editor; the host would drop it anyway.
	useEffect(() => {
		if (running) {
			store.cancelEdit();
		}
	}, [running, store]);

	const onEdit = useCallback((messageId: string) => store.startEdit(messageId), [store]);

	if (sourceRef.current !== store.messages) {
		sourceRef.current = store.messages;
		layoutRef.current = new VirtualLayout(ESTIMATED_HEIGHT);
		stickRef.current = true;
	}
	const latest = store.messages[store.messages.length - 1];
	const latestText = latest?.parts.flatMap(part => part.kind === "text" ? [part.text] : []).join("\n\n") ?? "";
	useEffect(() => {
		const previous = latestRef.current;
		if (previous && previous.source === store.messages && !stickRef.current && (store.messages.length > previous.count || (latest?.id === previous.id && latestText.length > previous.text.length))) {
			setHasNew(true);
		}
		// Another chat starts at its bottom.
		if (previous && previous.source !== store.messages) {
			setHasNew(false);
			setAway(false);
		}
		latestRef.current = { source: store.messages, count: store.messages.length, id: latest?.id, text: latestText };
	});
	const layout = layoutRef.current as VirtualLayout;
	layout.setCount(store.messages.length);

	useEffect(() => () => {
		observerRef.current?.disconnect();
		observerRef.current = null;
		if (frameRef.current) {
			cancelAnimationFrame(frameRef.current);
		}
		if (passesFrameRef.current) {
			cancelAnimationFrame(passesFrameRef.current);
		}
	}, []);

	const requestScrollSync = () => {
		if (frameRef.current) {
			return;
		}
		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = 0;
			const node = scrollerRef.current;
			if (node) {
				setScrollTop(node.scrollTop);
			}
		});
	};

	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller) {
			return;
		}
		let observer = observerRef.current;
		if (!observer) {
			observer = new ResizeObserver(entries => {
				let changed = false;
				const viewTop = scrollerRef.current?.scrollTop ?? 0;
				for (const entry of entries) {
					const target = entry.target as HTMLElement;
					if (target === scrollerRef.current) {
						setViewportHeight(target.clientHeight);
						continue;
					}
					const messageId = target.dataset.messageId;
					// A message that left the rendered range reports a last size of 0; its measured height still holds.
					if (!messageId || !target.isConnected) {
						continue;
					}
					const index = store.indexOf(messageId);
					if (index === undefined) {
						continue;
					}
					const current = layoutRef.current;
					if (!current) {
						continue;
					}
					const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
					const top = current.offsetOf(index);
					const previous = current.offsetOf(index + 1) - top;
					if (current.setHeight(index, height)) {
						changed = true;
						// A message wholly above the viewport moves everything below it; scroll along so the view stays put.
						if (!stickRef.current && top + previous <= viewTop + shiftRef.current) {
							shiftRef.current += height - previous;
						}
					}
				}
				if (changed) {
					setRevision(revision => revision + 1);
				}
			});
			observerRef.current = observer;
		}
		const observed = observedRef.current;
		const current = new Set<Element>();
		scroller.querySelectorAll(".chat-message[data-message-id]").forEach(element => current.add(element));
		for (const element of current) {
			if (!observed.has(element)) {
				observer.observe(element);
				observed.add(element);
			}
		}
		for (const element of observed) {
			if (!current.has(element)) {
				observer.unobserve(element);
				observed.delete(element);
			}
		}
		observer.observe(scroller);
	});

	// Layout effect: the correction lands before the browser paints the moved content.
	useLayoutEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller) {
			return;
		}
		if (stickRef.current) {
			shiftRef.current = 0;
			const bottom = scroller.scrollHeight - scroller.clientHeight;
			if (Math.abs(scroller.scrollTop - bottom) > 1) {
				scroller.scrollTop = bottom;
			}
		} else if (shiftRef.current !== 0) {
			scroller.scrollTop += shiftRef.current;
			shiftRef.current = 0;
		}
		const top = scroller.scrollTop;
		const distance = scroller.scrollHeight - top - scroller.clientHeight;
		setAway(distance > STICK_THRESHOLD);
		if (distance <= 1) { setHasNew(false); }
		lastTopRef.current = top;
		if (top === scrollTop) {
			return;
		}
		if (passesRef.current >= MAX_SYNC_SCROLL_PASSES) {
			requestScrollSync();
			return;
		}
		passesRef.current += 1;
		if (!passesFrameRef.current) {
			passesFrameRef.current = requestAnimationFrame(() => {
				passesFrameRef.current = 0;
				passesRef.current = 0;
			});
		}
		setScrollTop(top);
	});

	const unstick = () => {
		stickRef.current = false;
	};

	const onWheel = (event: WheelEvent) => {
		if (event.deltaY < 0) {
			unstick();
		}
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (SCROLL_UP_KEYS.has(event.key)) {
			unstick();
		}
	};

	const onPointerDown = (event: PointerEvent) => {
		// A press on the scroller itself, not on a message, grabs the scrollbar.
		if (event.target === event.currentTarget) {
			unstick();
		}
	};

	const onScroll = () => {
		const scroller = scrollerRef.current;
		if (!scroller) {
			return;
		}
		const top = scroller.scrollTop;
		const distance = scroller.scrollHeight - top - scroller.clientHeight;
		setAway(distance > STICK_THRESHOLD);
		if (distance <= 1) { setHasNew(false); }
		// Any upward move releases the bottom, however small; only coming back down near the end sticks again.
		if (distance <= 1) {
			stickRef.current = true;
		} else if (top < lastTopRef.current - 0.5) {
			stickRef.current = false;
		} else if (distance <= STICK_THRESHOLD && top > lastTopRef.current) {
			stickRef.current = true;
		}
		lastTopRef.current = top;
		requestScrollSync();
	};

	const viewport = viewportHeight || scrollerRef.current?.clientHeight || 600;
	const { start, end } = layout.range(scrollTop, viewport, OVERSCAN);
	const boundaryId = compactionBoundaryId(store.messages);
	const editingId = store.editing?.messageId;
	const items: ComponentChildren[] = [];
	for (let index = start; index < end; index += 1) {
		const message = store.messages[index];
		if (!message) {
			continue;
		}
		items.push(
			<div
				key={message.id}
				class="chat-message"
				data-message-id={message.id}
				style={{ transform: `translateY(${layout.offsetOf(index)}px)` }}
			>
				<MessageItem
					message={message}
					version={store.versionOf(message.id)}
					running={running}
					editing={message.id === editingId}
					compactionBoundary={message.id === boundaryId}
					isLast={index === store.messages.length - 1}
					autoContinue={index === store.messages.length - 1 ? store.session?.autoContinue : undefined}
					changedFilesSinceTurn={message.id === editingId ? store.filesChangedSince(message.turn) : 0}
					context={context}
					store={store}
					onEdit={onEdit}
					liveSubagentRun={store.subagentRun}
				/>
			</div>,
		);
	}

	const scrollLabel = hasNew ? "Scroll to the new message" : "Scroll to the latest message";
	const scrollToBottom = () => {
		const scroller = scrollerRef.current;
		if (!scroller) {
			return;
		}
		stickRef.current = true;
		scroller.scrollTop = scroller.scrollHeight;
		setAway(false);
		setHasNew(false);
		requestScrollSync();
	};
	return (
		<div class="message-list-wrap">
			<div
				class="message-scroller"
				ref={scrollerRef}
				onScroll={onScroll}
				onWheel={onWheel}
				onKeyDown={onKeyDown}
				onPointerDown={onPointerDown}
			>
				<div class="message-canvas" style={{ height: `${layout.totalHeight}px` }}>{items}</div>
			</div>
			{away ? (
				<button
					type="button"
					class={`message-scroll-bottom${hasNew ? " message-scroll-bottom-new" : ""}`}
					aria-label={scrollLabel}
					title={scrollLabel}
					onClick={scrollToBottom}
				>
					↓
				</button>
			) : null}
		</div>
	);
}
