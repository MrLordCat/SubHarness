import { useState } from "preact/hooks";
import { postMessage } from "./api";
import type { ChatStore } from "./store";

/** The shown chat's open subagents: each keeps its context for follow-up tasks until the agent or the user closes it. */
export function OpenSubagentsPanel({ store }: { store: ChatStore }) {
	const [expanded, setExpanded] = useState(true);
	const agents = store.openSubagents;
	if (agents.length === 0) {
		return null;
	}
	const working = agents.filter(agent => agent.status === "running").length;
	return (
		<section class="open-subagents">
			<button type="button" class="open-subagents-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
				<span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
				<strong>Open subagents {agents.length}</strong>
				{working > 0 ? <span class="open-subagents-muted">· {working} working</span> : null}
			</button>
			{expanded ? <div class="open-subagents-list">
				{agents.map(agent => {
					const detail = agent.status === "running" ? agent.activity ?? "Starting…" : `Last task: ${agent.task}`;
					const report = agent.report ? `Report: ${agent.report}` : undefined;
					return (
						<div class="open-subagent-row" key={agent.id}>
							<span class="open-subagent-mark" aria-hidden="true">{agent.status === "running" ? <span class="tool-spinner" /> : "○"}</span>
							<div class="open-subagent-content">
								<div class="open-subagent-heading">
									<strong class="open-subagent-description" title={agent.description}>{agent.description}</strong>
									<span class="open-subagent-meta" title={`${agent.id} · ${agent.modelName}`}>{agent.id} · {agent.modelName}</span>
								</div>
								<div class="open-subagent-detail" title={detail}>{detail}</div>
								{agent.status === "idle" && report ? <div class="open-subagent-detail" title={report}>{report}</div> : null}
							</div>
							<button type="button" class="open-subagent-close" title="Close subagent" aria-label={`Close subagent ${agent.id}`} disabled={agent.status === "running"} onClick={() => {
								if (store.session) {
									postMessage({ type: "closeSubagent", sessionId: store.session.id, subagentId: agent.id });
								}
							}}>×</button>
						</div>
					);
				})}
			</div> : null}
		</section>
	);
}
