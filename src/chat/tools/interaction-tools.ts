import * as vscode from "vscode";
import type { ChatQuestion, ChatQuestionAnswer, ChatQuestionOption } from "../shared/protocol";
import { checkTodoList, parseTodoList } from "../shared/todo";
import { CHAT_TOOL_GROUPS, type ChatTool } from "./types";

export const TODO_TOOL_NAME = "manage_todo_list";
export const ASK_QUESTIONS_TOOL_NAME = "ask_questions";

const MAX_QUESTIONS = 5;
const MAX_HEADER_CHARS = 50;
const MAX_QUESTION_CHARS = 300;
const MAX_OPTIONS = 10;

const TODO_DESCRIPTION = "Keeps a todo list for multi-step work, shown to the user above the chat input. Send the whole list every time: mark one item in-progress before you start it and completed right after you finish it. Skip it for simple one-step requests.";

const ASK_QUESTIONS_DESCRIPTION = "Asks the user up to 5 short questions in the chat and waits for the answers, e.g. to choose between approaches or to fill in a missing detail. Offer options when the choices are known and mark the one you recommend. Do not ask what you can find out with the other tools.";

const DISMISSED_TEXT = "The user dismissed the questions without answering. Continue with your best judgement, or ask in your reply.";

/** The agent's visible plan; the webview draws it from the newest successful call. */
export function createTodoTool(): ChatTool {
	return {
		name: TODO_TOOL_NAME,
		group: CHAT_TOOL_GROUPS.planning,
		description: TODO_DESCRIPTION,
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				todoList: {
					type: "array",
					maxItems: 50,
					description: "Every todo item; it replaces the previous list, so send the whole list each time.",
					items: {
						type: "object",
						properties: {
							id: { type: "integer", minimum: 1, description: "Item number, kept stable across updates." },
							title: { type: "string", description: "3-7 word action label." },
							status: { type: "string", enum: ["not-started", "in-progress", "completed"], description: "Where the item stands now." },
						},
						required: ["id", "title", "status"],
					},
				},
			},
			required: ["todoList"],
		},
		invoke: async input => {
			const items = parseTodoList(input);
			if (!items) {
				const checked = checkTodoList(input);
				throw new Error("error" in checked ? checked.error : "Invalid todo list.");
			}
			if (items.length === 0) {
				return "Todo list cleared.";
			}
			const done = items.filter(item => item.status === "completed").length;
			const active = items.filter(item => item.status === "in-progress").length;
			const lines = [`Todo list updated: ${items.length} items, ${done} completed, ${active} in progress.`];
			if (active > 1) {
				lines.push("Keep only one item in progress at a time.");
			}
			return lines.join("\n");
		},
	};
}

function textValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function flag(record: Record<string, unknown>, key: string, question: string): boolean | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new Error(`Question "${question}" has a non-boolean ${key}.`);
	}
	return value;
}

function parseOptions(value: unknown, header: string): ChatQuestionOption[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new Error(`Question "${header}" options must be an array.`);
	}
	if (value.length > MAX_OPTIONS) {
		throw new Error(`Question "${header}" has more than ${MAX_OPTIONS} options.`);
	}
	const labels = new Set<string>();
	return value.map((raw, index) => {
		const option = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
		const label = textValue(option.label);
		if (!label) {
			throw new Error(`Question "${header}" option ${index + 1} needs a non-empty label.`);
		}
		if (labels.has(label)) {
			throw new Error(`Question "${header}" has the option "${label}" twice.`);
		}
		labels.add(label);
		const description = textValue(option.description);
		const recommended = option.recommended;
		if (recommended !== undefined && typeof recommended !== "boolean") {
			throw new Error(`Question "${header}" option "${label}" has a non-boolean recommended flag.`);
		}
		return {
			label,
			...(description ? { description } : {}),
			...(recommended === true ? { recommended: true } : {}),
		};
	});
}

/** Reads and checks the call's arguments; the messages tell the model what to fix. */
function parseQuestions(input: unknown): ChatQuestion[] {
	const record = typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
	const raw = record.questions;
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_QUESTIONS) {
		throw new Error(`questions must be an array of 1 to ${MAX_QUESTIONS} items.`);
	}
	const headers = new Set<string>();
	return raw.map((value, index) => {
		const question = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
		const header = textValue(question.header);
		if (!header) {
			throw new Error(`questions[${index}].header must not be empty.`);
		}
		if (header.length > MAX_HEADER_CHARS) {
			throw new Error(`questions[${index}].header must be at most ${MAX_HEADER_CHARS} characters.`);
		}
		if (headers.has(header)) {
			throw new Error(`Question headers must be unique; "${header}" appears twice.`);
		}
		headers.add(header);
		const text = textValue(question.question);
		if (!text) {
			throw new Error(`questions[${index}].question must not be empty.`);
		}
		if (text.length > MAX_QUESTION_CHARS) {
			throw new Error(`questions[${index}].question must be at most ${MAX_QUESTION_CHARS} characters.`);
		}
		const message = textValue(question.message);
		const options = parseOptions(question.options, header);
		const multiSelect = flag(question, "multiSelect", header);
		const allowFreeformInput = flag(question, "allowFreeformInput", header);
		if (allowFreeformInput === false && (!options || options.length === 0)) {
			throw new Error(`Question "${header}" has no options, so it cannot disallow freeform input.`);
		}
		return {
			header,
			question: text,
			...(message ? { message } : {}),
			...(options ? { options } : {}),
			...(multiSelect === undefined ? {} : { multiSelect }),
			...(allowFreeformInput === undefined ? {} : { allowFreeformInput }),
		};
	});
}

/** Formats the answers in the asked order, with "(no answer)" for questions the user left empty. */
function answerText(questions: readonly ChatQuestion[], answers: readonly ChatQuestionAnswer[]): string {
	const byHeader = new Map(answers.map(answer => [answer.header, answer]));
	return questions.map(question => {
		const answer = byHeader.get(question.header);
		const parts: string[] = [];
		if (answer && answer.selected.length > 0) {
			parts.push(answer.selected.join("; "));
		}
		if (answer?.freeform) {
			parts.push(`"${answer.freeform}"`);
		}
		return `${question.header}: ${parts.length > 0 ? parts.join("; ") : "(no answer)"}`;
	}).join("\n");
}

/** Asks the user in the chat; the controller supplies askQuestions, so the tool cannot run elsewhere. */
export function createAskQuestionsTool(): ChatTool {
	return {
		name: ASK_QUESTIONS_TOOL_NAME,
		group: CHAT_TOOL_GROUPS.planning,
		description: ASK_QUESTIONS_DESCRIPTION,
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				questions: {
					type: "array",
					minItems: 1,
					maxItems: 5,
					description: "Questions to ask, from 1 to 5.",
					items: {
						type: "object",
						properties: {
							header: { type: "string", maxLength: 50, description: "Short unique label, used to match the answer." },
							question: { type: "string", maxLength: 300, description: "The question text." },
							message: { type: "string", description: "Optional extra context shown under the question." },
							options: {
								type: "array",
								maxItems: 10,
								description: "Choices to offer; omit for a free-text answer.",
								items: {
									type: "object",
									properties: {
										label: { type: "string", description: "Short answer shown on the button." },
										description: { type: "string", description: "Optional detail shown under the label." },
										recommended: { type: "boolean", description: "Marks the choice you recommend (default false)." },
									},
									required: ["label"],
								},
							},
							multiSelect: { type: "boolean", description: "Allow several choices at once (default false)." },
							allowFreeformInput: { type: "boolean", description: "Lets the user type an answer; default true." },
						},
						required: ["header", "question"],
					},
				},
			},
			required: ["questions"],
		},
		invoke: async (input, token, context) => {
			if (!context?.askQuestions) {
				throw new Error("ask_questions is only available to the main chat agent.");
			}
			const questions = parseQuestions(input);
			const answers = await context.askQuestions(questions, token);
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			if (answers === undefined) {
				return DISMISSED_TEXT;
			}
			return answerText(questions, answers);
		},
	};
}
