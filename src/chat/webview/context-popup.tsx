import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ChatContextSettings, ChatContextSettingsChange } from "../shared/protocol";
import { postMessage } from "./api";
import { formatTokens } from "./format";
import { popupPlacement, useDismiss, useKeepInView } from "./popup";

interface ContextIndicatorProps {
	/** Prompt tokens of the last request over the model window, once both are known. */
	context: string | undefined;
	/** Absent when the host offers no settings; the indicator is then plain text. */
	settings: ChatContextSettings | undefined;
}

const SLIDER_STEP = 1_024;

/** The context indicator; a click opens the shared-context and model-switch sliders. */
export function ContextIndicator({ context, settings }: ContextIndicatorProps) {
	const [open, setOpen] = useState(false);
	const [placement, setPlacement] = useState<"above" | "below">("above");
	// Values while a slider is dragged; they are saved when it is released.
	const [shared, setShared] = useState(settings?.shared ?? 0);
	const [switchTokens, setSwitchTokens] = useState(settings?.switchTokens ?? 0);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const close = useCallback(() => setOpen(false), []);
	useDismiss(wrapperRef, open, close);
	useKeepInView(popupRef, open);
	// Stored values win whenever they change, e.g. after the Provider Context panel saved.
	useEffect(() => {
		if (settings) {
			setShared(settings.shared);
			setSwitchTokens(settings.switchTokens);
		}
	}, [settings?.shared, settings?.switchTokens]);

	if (!settings) {
		return context ? <span class="context-indicator" title="Prompt tokens / context window">{context}</span> : null;
	}

	const save = (change: ChatContextSettingsChange) => postMessage({ type: "saveContextSettings", change });
	// Until Codex reports a window the slider value applies, so it stays editable.
	const following = settings.followCodex && settings.codexWindow !== undefined;
	const sharedShown = following ? settings.codexWindow ?? shared : shared;
	const codexLabel = settings.codexWindow === undefined
		? "no Codex window known yet"
		: `${formatTokens(settings.codexWindow)}${settings.codexModel ? `, ${settings.codexModel}` : ""}`;
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || !open) {
			return;
		}
		event.preventDefault();
		setOpen(false);
		triggerRef.current?.focus();
	};

	return (
		<div class="picker context-picker" ref={wrapperRef} onKeyDown={onKeyDown}>
			<button
				type="button"
				ref={triggerRef}
				class="context-indicator context-trigger"
				aria-haspopup="dialog"
				aria-expanded={open}
				title="Prompt tokens / context window. Click for the shared context and the model-switch limit."
				onClick={() => {
					if (open) {
						setOpen(false);
						return;
					}
					setPlacement(popupPlacement(triggerRef.current));
					setOpen(true);
				}}
			>
				{context ?? "Context"}
			</button>
			{open ? (
				<div ref={popupRef} class={`picker-popup context-popup picker-popup-${placement}`} role="dialog" aria-label="Context settings" tabIndex={-1}>
					{context ? <div class="context-usage">{`Last request: ${context} tokens`}</div> : null}
					<div class="context-setting">
						<div class="context-setting-head">
							<span class="context-setting-label">Shared context</span>
							<span class="context-setting-value">{formatTokens(sharedShown)}</span>
						</div>
						<input
							type="range"
							class="context-slider"
							aria-label="Shared context"
							min={settings.sharedMin}
							max={settings.sharedMax}
							step={SLIDER_STEP}
							value={sharedShown}
							disabled={following}
							onInput={event => setShared(Number(event.currentTarget.value))}
							onChange={event => save({ shared: Number(event.currentTarget.value) })}
						/>
						<label class="context-toggle">
							<input type="checkbox" checked={settings.followCodex} onChange={event => save({ followCodex: event.currentTarget.checked })} />
							{`Follow the Codex window (${codexLabel})`}
						</label>
						<div class="context-hint">Codex, Claude, Coco and Cursor, each capped by its model window. Applies to new requests.</div>
					</div>
					<div class="context-setting">
						<div class="context-setting-head">
							<span class="context-setting-label">Model switch</span>
							<span class="context-setting-value">{formatTokens(switchTokens)}</span>
						</div>
						<input
							type="range"
							class="context-slider"
							aria-label="Context handed over on a model switch"
							min={settings.switchMin}
							max={settings.switchMax}
							step={SLIDER_STEP}
							value={switchTokens}
							onInput={event => setSwitchTokens(Number(event.currentTarget.value))}
							onChange={event => save({ switchTokens: Number(event.currentTarget.value) })}
						/>
						<div class="context-hint">A model taking over a longer chat gets it compacted first.</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
