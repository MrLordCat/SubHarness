import { useState } from "preact/hooks";
import type { ChatTodoItem } from "../shared/protocol";

const STATUS_MARKS: Record<ChatTodoItem["status"], string> = {
	"not-started": "○",
	"in-progress": "◐",
	completed: "✓",
};

/** The agent's plan above the composer; collapsed by default and only expanded state is remembered. */
export function TodoPanel({ todos, running }: { todos: readonly ChatTodoItem[]; running: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const done = todos.filter(todo => todo.status === "completed").length;
	const current = todos.find(todo => todo.status === "in-progress") ?? todos.find(todo => todo.status === "not-started");
	return (
		<section class="todo-panel" aria-busy={running}>
			<button type="button" class="todo-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
				<span class="todo-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
				<span class="todo-count">Todos {done}/{todos.length}</span>
				{current ? <span class="todo-current">{current.title}</span> : null}
			</button>
			{expanded ? (
				<ol class="todo-list">
					{todos.map(todo => (
						<li class={`todo-item todo-${todo.status}`} key={todo.id}>
							<span class="todo-mark" aria-hidden="true">{STATUS_MARKS[todo.status]}</span>
							<span class="todo-title">{todo.title}</span>
						</li>
					))}
				</ol>
			) : null}
		</section>
	);
}
