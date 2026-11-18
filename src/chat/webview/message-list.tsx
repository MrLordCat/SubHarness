import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ChatMessage } from "../shared/protocol";
import { VirtualLayout } from "../shared/virtual-layout";
import { MessageItem } from "./message";
import type { ChatStore } from "./store";

const ESTIMATED_HEIGHT = 80;
const OVERSCAN = 800;
const STICK_THRESHOLD = 40;

interface MessageListProps {
	store: ChatStore;
	running: boolean;
	onEditMessage: (messageId: string, text: string, undoChanges: boolean) => void;
	onLoadToolResult: (messageId: string, callId: string) => void;
}

export function MessageList({ store, running, onEditMessage, onLoadToolResult }: MessageListProps) {
	const scrollerRef = useRef<HTMLDivElement>(null);
	const observerRef = useRef<ResizeObserver | null>(null);
	const observedRef = useRef(new Set<Element>());
	const layoutRef = useRef<VirtualLayout | null>(null);
	const sourceRef = useRef<ChatMessage[] | null>(null);
	const stickRef = useRef(true);
	const frameRef = useRef(0);
	const [viewportHeight, setViewportHeight] = useState(0);
	const [scrollTop, setScrollTop] = useState(0);
	const [editingId, setEditingId] = useState<string | undefined>(undefined);
	const [, setRevision] = useState(0);

	useEffect(() => {
		if (running && editingId !== undefined) {
			setEditingId(undefined);
		}
	}, [running, editingId]);

	const onEdit = useCallback((messageId: string) => setEditingId(messageId), []);
	const onCancelEdit = useCallback(() => setEditingId(undefined), []);
	const submitEdit = useCallback((messageId: string, text: string, undoChanges: boolean) => {
		setEditingId(undefined);
		onEditMessage(messageId, text, undoChanges);
	}, [onEditMessage]);

	if (sourceRef.current !== store.messages) {
		sourceRef.current = store.messages;
		layoutRef.current = new VirtualLayout(ESTIMATED_HEIGHT);
		stickRef.current = true;
	}
	const layout = layoutRef.current as VirtualLayout;
	layout.setCount(store.messages.length);

	useEffect(() => () => {
		observerRef.current?.disconnect();
		observerRef.current = null;
		if (frameRef.current) {
			cancelAnimationFrame(frameRef.current);
		}
	}, []);

	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller) {
			return;
		}
		let observer = observerRef.current;
		if (!observer) {
			observer = new ResizeObserver(entries => {
				let changed = false;
				for (const entry of entries) {
					const target = entry.target as HTMLElement;
					if (target === scrollerRef.current) {
						setViewportHeight(target.clientHeight);
						continue;
					}
					const messageId = target.dataset.messageId;
					if (!messageId) {
						continue;
					}
					const index = store.indexOf(messageId);
					if (index === undefined) {
						continue;
					}
					const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
					if (layoutRef.current?.setHeight(index, height)) {
						changed = true;
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

	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller) {
			return;
		}
		if (stickRef.current) {
			const bottom = scroller.scrollHeight - scroller.clientHeight;
			if (Math.abs(scroller.scrollTop - bottom) > 1) {
				scroller.scrollTop = bottom;
			}
		}
		setScrollTop(current => current === scroller.scrollTop ? current : scroller.scrollTop);
	});

	const onScroll = () => {
		const scroller = scrollerRef.current;
		if (!scroller) {
			return;
		}
		stickRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_THRESHOLD;
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

	const viewport = viewportHeight || scrollerRef.current?.clientHeight || 600;
	const { start, end } = layout.range(scrollTop, viewport, OVERSCAN);
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
					changedFilesSinceTurn={message.id === editingId ? store.filesChangedSince(message.turn) : 0}
					onEdit={onEdit}
					onCancelEdit={onCancelEdit}
					onEditMessage={submitEdit}
					onLoadToolResult={onLoadToolResult}
				/>
			</div>,
		);
	}

	return (
		<div class="message-scroller" ref={scrollerRef} onScroll={onScroll}>
			<div class="message-canvas" style={{ height: `${layout.totalHeight}px` }}>{items}</div>
		</div>
	);
}
