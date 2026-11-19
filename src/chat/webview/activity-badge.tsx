import type { ChatSessionActivity } from "../shared/protocol";

interface ActivityBadgeProps {
	activity: ChatSessionActivity[];
	onClick: () => void;
}

function runningLabel(count: number): string {
	return count === 1 ? "1 chat running" : `${count} chats running`;
}

function activityLabel(running: number, approval: number, finished: number): string {
	const parts: string[] = [];
	if (running > 0) {
		parts.push(runningLabel(running));
	}
	if (approval > 0) {
		parts.push(`${approval} waiting for approval`);
	}
	if (finished > 0) {
		parts.push(`${finished} finished`);
	}
	return `${parts.join(", ")} — show chats`;
}

export function ActivityBadge({ activity, onClick }: ActivityBadgeProps) {
	let running = 0;
	let approval = 0;
	let finished = 0;
	for (const entry of activity) {
		if (entry.state === "running") {
			running += 1;
		} else if (entry.state === "approval") {
			approval += 1;
		} else {
			finished += 1;
		}
	}
	if (running + approval + finished === 0) {
		return null;
	}
	const label = activityLabel(running, approval, finished);
	return (
		<button type="button" class="activity-badge" aria-label={label} title={label} onClick={onClick}>
			{running > 0 ? <span class="activity-running"><span class="activity-dot" aria-hidden="true">●</span> {running}</span> : null}
			{approval > 0 ? <span class="activity-approval">! {approval}</span> : null}
			{finished > 0 ? <span class="activity-finished">✓ {finished}</span> : null}
		</button>
	);
}
