import type { ChatMessage, ChatTodoItem } from "./protocol";

/** Same name as the chat tool; the webview reads the list without the extension host. */
const TODO_TOOL_NAME = "manage_todo_list";
const MAX_TODOS = 50;
const MAX_TITLE_CHARS = 200;
const STATUSES: readonly ChatTodoItem["status"][] = ["not-started", "in-progress", "completed"];

export type TodoListCheck = { items: ChatTodoItem[] } | { error: string };

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The one validator of manage_todo_list calls, so the tool and the webview accept the same lists. */
export function checkTodoList(input: unknown): TodoListCheck {
	const value = record(input);
	if (!value) {
		return { error: "Tool input must be an object." };
	}
	const raw = value.todoList;
	if (!Array.isArray(raw)) {
		return { error: "todoList must be an array." };
	}
	if (raw.length > MAX_TODOS) {
		return { error: `todoList must have at most ${MAX_TODOS} items.` };
	}
	const ids = new Set<number>();
	const items: ChatTodoItem[] = [];
	for (let index = 0; index < raw.length; index += 1) {
		const item = record(raw[index]);
		if (!item) {
			return { error: `todoList[${index}] must be an object.` };
		}
		const id = item.id;
		if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
			return { error: `todoList[${index}].id must be an integer of at least 1.` };
		}
		if (ids.has(id)) {
			return { error: `todoList ids must be unique; ${id} appears twice.` };
		}
		ids.add(id);
		const title = typeof item.title === "string" ? item.title.trim() : "";
		if (!title) {
			return { error: `todoList[${index}].title must not be empty.` };
		}
		if (title.length > MAX_TITLE_CHARS) {
			return { error: `todoList[${index}].title must be at most ${MAX_TITLE_CHARS} characters.` };
		}
		const status = item.status;
		if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) {
			return { error: `todoList[${index}].status must be "not-started", "in-progress" or "completed".` };
		}
		items.push({ id, title, status: status as ChatTodoItem["status"] });
	}
	return { items };
}

export function parseTodoList(input: unknown): ChatTodoItem[] | undefined {
	const checked = checkTodoList(input);
	return "items" in checked ? checked.items : undefined;
}

/** The newest list a successful manage_todo_list call returned in these messages. */
export function latestTodoList(messages: readonly ChatMessage[]): ChatTodoItem[] | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const parts = messages[index].parts;
		for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
			const part = parts[partIndex];
			if (part.kind !== "toolCall" || part.name !== TODO_TOOL_NAME) {
				continue;
			}
			const result = parts.find(candidate => candidate.kind === "toolResult" && candidate.callId === part.callId);
			if (result?.kind !== "toolResult" || result.isError) {
				continue;
			}
			const items = parseTodoList(part.input);
			if (items) {
				return items;
			}
		}
	}
	return undefined;
}
