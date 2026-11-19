import { useCallback, useRef, useState } from "preact/hooks";
import type { ChatProviderQuota } from "../shared/protocol";
import { formatQuotaChip, formatQuotaTitle, formatReset, quotaLevel, quotaSeverity } from "./format";
import { popupPlacement, useDismiss, useKeepInView } from "./popup";

interface QuotaIndicatorProps {
	quota: ChatProviderQuota[];
	provider: string | undefined;
	/** Asks the host for fresh numbers; sent whenever the popup opens. */
	onRefresh: () => void;
}

export function QuotaIndicator({ quota, provider, onRefresh }: QuotaIndicatorProps) {
	const [open, setOpen] = useState(false);
	const [placement, setPlacement] = useState<"above" | "below">("above");
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

	const current = provider === undefined ? undefined : quota.find(entry => entry.provider === provider);
	const chip = current ? formatQuotaChip(current) : "";
	if (!current || !chip) {
		return null;
	}

	const openPopup = () => {
		setPlacement(popupPlacement(triggerRef.current));
		setOpen(true);
		onRefresh();
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Escape") {
			return;
		}
		event.preventDefault();
		closeAndFocus();
	};

	return (
		<div class="picker quota-picker" ref={wrapperRef} onKeyDown={onKeyDown}>
			<button
				type="button"
				ref={triggerRef}
				class={`quota-chip quota-${quotaSeverity(current)}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				title={formatQuotaTitle(current)}
				onClick={() => (open ? setOpen(false) : openPopup())}
			>
				{chip}
			</button>
			{open ? (
				<div
					ref={popupRef}
					class={`picker-popup quota-popup picker-popup-${placement}`}
					role="dialog"
					aria-label="Provider limits"
					tabIndex={-1}
				>
					{quota.map(entry => (
						<div class="quota-entry" key={entry.provider}>
							<div class="quota-entry-head">
								<span class="quota-provider">{entry.provider}</span>
								{entry.plan ? <span class="quota-plan">{entry.plan}</span> : null}
							</div>
							{entry.windows.map(window => (
								<div class="quota-window" key={window.label}>
									<div class="quota-window-head">
										<span class="quota-window-label">{window.label}</span>
										<span class="quota-window-percent">{Math.round(window.percent)}%</span>
									</div>
									<div class="quota-bar">
										<span
											class={`quota-bar-fill quota-${quotaLevel(window.percent)}`}
											style={{ width: `${Math.max(0, Math.min(100, window.percent))}%` }}
										/>
									</div>
									{window.resetsAt !== undefined
										? <div class="quota-resets">resets {formatReset(window.resetsAt, Date.now())}</div>
										: null}
								</div>
							))}
							{entry.balance ? <div class="quota-balance">{entry.balance}</div> : null}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
