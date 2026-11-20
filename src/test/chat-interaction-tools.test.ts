import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ChatMessage, ChatQuestion } from "../chat/shared/protocol";
import { latestTodoList, parseTodoList } from "../chat/shared/todo";
import { ASK_QUESTIONS_TOOL_NAME, createAskQuestionsTool, createTodoTool, TODO_TOOL_NAME } from "../chat/tools/interaction-tools";

const DISMISSED_TEXT = "The user dismissed the questions without answering. Continue with your best judgement, or ask in your reply.";

function todoMessage(callId: string, input: unknown, options: { result?: boolean; isError?: boolean } = {}): ChatMessage {
	const parts: ChatMessage["parts"] = [{ kind: "toolCall", callId, name: TODO_TOOL_NAME, input }];
	if (options.result !== false) {
		parts.push({ kind: "toolResult", callId, text: "ok", ...(options.isError ? { isError: true } : {}) });
	}
	return { id: `message-${callId}`, role: "assistant", turn: 1, createdAt: 0, parts };
}

const TODO_INPUT = {
	todoList: [
		{ id: 1, title: "Read the code", status: "completed" },
		{ id: 2, title: "Write the code", status: "in-progress" },
	],
};

const ASK_INPUT = {
	questions: [
		{
			header: "Approach",
			question: "Which one?",
			options: [{ label: "Refactor" }, { label: "Rewrite" }],
			allowFreeformInput: true,
		},
		{
			header: "Name",
			question: "Which names?",
			multiSelect: true,
			options: [{ label: "a" }, { label: "b" }],
		},
		{
			header: "Notes",
			question: "Anything else?",
			options: [{ label: "No" }],
			allowFreeformInput: false,
		},
	],
};

suite("Chat interaction tools", () => {
	const tokens: vscode.CancellationTokenSource[] = [];

	teardown(() => {
		for (const source of tokens.splice(0)) {
			source.dispose();
		}
	});

	function token(): vscode.CancellationToken {
		const source = new vscode.CancellationTokenSource();
		tokens.push(source);
		return source.token;
	}

	async function todoText(input: unknown): Promise<string> {
		const result = await createTodoTool().invoke(input, token());
		return typeof result === "string" ? result : result.text;
	}

	async function askText(input: unknown, askQuestions: (questions: ChatQuestion[]) => Promise<{ header: string; selected: string[]; freeform?: string }[] | undefined>): Promise<string> {
		const result = await createAskQuestionsTool().invoke(input, token(), { askQuestions: (questions) => askQuestions(questions) });
		return typeof result === "string" ? result : result.text;
	}

	test("the planning tools are read-only and registered by name", () => {
		assert.strictEqual(TODO_TOOL_NAME, "manage_todo_list");
		assert.strictEqual(ASK_QUESTIONS_TOOL_NAME, "ask_questions");
		assert.strictEqual(createTodoTool().group, "planning");
		assert.strictEqual(createAskQuestionsTool().group, "planning");
		assert.strictEqual(createTodoTool().readOnly, true);
		assert.strictEqual(createAskQuestionsTool().readOnly, true);
	});

	test("manage_todo_list reports the counts and the single-in-progress hint", async () => {
		assert.strictEqual(await todoText(TODO_INPUT), "Todo list updated: 2 items, 1 completed, 1 in progress.");
		const busy = {
			todoList: [
				{ id: 1, title: "One", status: "in-progress" },
				{ id: 2, title: "Two", status: "in-progress" },
			],
		};
		assert.strictEqual(
			await todoText(busy),
			"Todo list updated: 2 items, 0 completed, 2 in progress.\nKeep only one item in progress at a time.",
		);
		assert.strictEqual(await todoText({ todoList: [] }), "Todo list cleared.");
		assert.strictEqual(await todoText({ todoList: [{ id: 7, title: "  Trimmed  ", status: "not-started" }] }),
			"Todo list updated: 1 items, 0 completed, 0 in progress.");
	});

	test("manage_todo_list rejects lists the webview would not read", async () => {
		const tool = createTodoTool();
		await assert.rejects(tool.invoke({ todoList: "x" }, token()), /must be an array/);
		await assert.rejects(
			tool.invoke({ todoList: [{ id: 1, title: "A", status: "completed" }, { id: 1, title: "B", status: "completed" }] }, token()),
			/must be unique/,
		);
		await assert.rejects(tool.invoke({ todoList: [{ id: 1, title: "A", status: "done" }] }, token()), /status must be/);
		await assert.rejects(tool.invoke({ todoList: [{ id: 1, title: "   ", status: "completed" }] }, token()), /title must not be empty/);
		await assert.rejects(tool.invoke({ todoList: [{ id: 1, title: "x".repeat(201), status: "completed" }] }, token()), /at most 200 characters/);
		const many = Array.from({ length: 51 }, (_, index) => ({ id: index + 1, title: `Item ${index}`, status: "not-started" }));
		await assert.rejects(tool.invoke({ todoList: many }, token()), /at most 50 items/);
	});

	test("parseTodoList accepts exactly what the tool accepts", async () => {
		assert.deepStrictEqual(parseTodoList(TODO_INPUT), TODO_INPUT.todoList);
		assert.deepStrictEqual(parseTodoList({ todoList: [{ id: 1, title: "  A  ", status: "not-started" }] }),
			[{ id: 1, title: "A", status: "not-started" }]);
		assert.strictEqual(parseTodoList({ todoList: [{ id: 0, title: "A", status: "completed" }] }), undefined);
		assert.strictEqual(parseTodoList({ todoList: [{ id: 1, title: "A", status: "unknown" }] }), undefined);
		assert.strictEqual(parseTodoList({}), undefined);
		assert.strictEqual(parseTodoList(undefined), undefined);
	});

	test("latestTodoList takes the newest successful call and skips failed or unanswered ones", () => {
		const older = todoMessage("call-old", TODO_INPUT);
		const newer = todoMessage("call-new", { todoList: [{ id: 3, title: "Newest", status: "not-started" }] });
		assert.deepStrictEqual(latestTodoList([older, newer]), [{ id: 3, title: "Newest", status: "not-started" }]);
		assert.deepStrictEqual(latestTodoList([newer, older]), TODO_INPUT.todoList);

		const errored = todoMessage("call-error", { todoList: [{ id: 9, title: "Broken", status: "not-started" }] }, { isError: true });
		assert.deepStrictEqual(latestTodoList([older, errored]), TODO_INPUT.todoList);

		const unanswered = todoMessage("call-waiting", { todoList: [{ id: 8, title: "Waiting", status: "not-started" }] }, { result: false });
		assert.deepStrictEqual(latestTodoList([older, unanswered]), TODO_INPUT.todoList);

		const invalid = todoMessage("call-invalid", { todoList: [{ id: 0, title: "Bad", status: "not-started" }] });
		assert.deepStrictEqual(latestTodoList([older, invalid]), TODO_INPUT.todoList);

		assert.strictEqual(latestTodoList([errored, unanswered]), undefined);
		assert.strictEqual(latestTodoList([]), undefined);
	});

	test("ask_questions rejects calls the webview could not show", async () => {
		const tool = createAskQuestionsTool();
		const ask = (input: unknown) => tool.invoke(input, token(), { askQuestions: async () => [] });
		await assert.rejects(ask({ questions: [] }), /1 to 5/);
		await assert.rejects(ask({ questions: Array.from({ length: 6 }, (_, index) => ({ header: `H${index}`, question: "Q" })) }), /1 to 5/);
		await assert.rejects(ask({ questions: [{ header: "", question: "Q" }] }), /header must not be empty/);
		await assert.rejects(ask({ questions: [{ header: "H".repeat(51), question: "Q" }] }), /at most 50 characters/);
		await assert.rejects(ask({ questions: [{ header: "A", question: "Q" }, { header: "A", question: "R" }] }), /must be unique/);
		await assert.rejects(ask({ questions: [{ header: "A", question: "  " }] }), /question must not be empty/);
		await assert.rejects(ask({ questions: [{ header: "A", question: "Q".repeat(301) }] }), /at most 300 characters/);
		await assert.rejects(
			ask({ questions: [{ header: "A", question: "Q", options: Array.from({ length: 11 }, (_, index) => ({ label: `o${index}` })) }] }),
			/more than 10 options/,
		);
		await assert.rejects(ask({ questions: [{ header: "A", question: "Q", options: [{ label: "x" }, { label: "x" }] }] }), /twice/);
		await assert.rejects(ask({ questions: [{ header: "A", question: "Q", allowFreeformInput: false }] }), /cannot disallow freeform/);
	});

	test("ask_questions formats the answers in the asked order", async () => {
		let asked: ChatQuestion[] = [];
		const text = await askText(ASK_INPUT, async questions => {
			asked = questions;
			return [
				{ header: "Approach", selected: ["Refactor"], freeform: "keep it small" },
				{ header: "Name", selected: ["a", "b"] },
				{ header: "Notes", selected: ["No"] },
			];
		});
		assert.deepStrictEqual(asked.map(question => question.header), ["Approach", "Name", "Notes"]);
		assert.strictEqual(text, "Approach: Refactor; \"keep it small\"\nName: a; b\nNotes: No");

		const empty = await askText(ASK_INPUT, async () => [{ header: "Approach", selected: [] }]);
		assert.strictEqual(empty, "Approach: (no answer)\nName: (no answer)\nNotes: (no answer)");

		const dismissed = await askText(ASK_INPUT, async () => undefined);
		assert.strictEqual(dismissed, DISMISSED_TEXT);
	});

	test("ask_questions needs the main chat agent and honours cancellation", async () => {
		const tool = createAskQuestionsTool();
		await assert.rejects(tool.invoke(ASK_INPUT, token()), /only available to the main chat agent/);

		const source = new vscode.CancellationTokenSource();
		tokens.push(source);
		source.cancel();
		await assert.rejects(tool.invoke(ASK_INPUT, source.token, { askQuestions: async () => undefined }), vscode.CancellationError);
	});
});
