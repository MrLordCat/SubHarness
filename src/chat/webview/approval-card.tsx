import { useCallback, useState } from "preact/hooks";
import type { ChatApprovalRequest } from "../shared/protocol";

interface ApprovalCardProps {
	request: ChatApprovalRequest;
	onApprove: (id: string, allow: boolean, always?: boolean) => void;
}

export function ApprovalCard({ request, onApprove }: ApprovalCardProps) {
	const [pending, setPending] = useState(false);
	const decide = useCallback((allow: boolean, always?: boolean) => {
		setPending(true);
		onApprove(request.id, allow, always);
	}, [onApprove, request.id]);

	return (
		<div class="approval-card" role="group" aria-label={request.title}>
			<div class="approval-title">{request.title}</div>
			{request.reason ? <div class="approval-reason">{request.reason}</div> : null}
			{request.kinds?.length ? <div class="approval-scope">Always allow covers: {request.kinds.map(kind => kind.label).join("; ")}</div> : null}
			<pre class="approval-detail"><code>{request.detail}</code></pre>
			<div class="approval-actions">
				<button type="button" class="approval-allow" disabled={pending} onClick={() => decide(true)}>Allow</button>
				{request.kinds?.length ? <button type="button" class="approval-always" disabled={pending} title="Applies in every workspace and can be revoked in the Tools list" onClick={() => decide(true, true)}>Always allow</button> : null}
				<button type="button" class="approval-deny" disabled={pending} onClick={() => decide(false)}>Deny</button>
			</div>
		</div>
	);
}
