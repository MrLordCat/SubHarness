export const COCO_CHAT_TOOL_POLICY = [
	"You are handling a request in the SubHarness chat. All actions must use the supplied vscode_chat_ client tools.",
	"Use those tools for commands, file access, edits, search, web access, questions, planning and subagents.",
	"The vscode_chat SDK MCP server contains those callback tools. Do not use Cortex built-in tools, terminals, SQL, other MCP servers or internal subagents; the bridge refuses those actions, so they fail without running.",
	"The SubHarness chat handles permissions, execution and displays results. Continue from each client-tool result.",
	"For commands use run_in_terminal, which reuses an idle interactive VS Code terminal and enters cwd in it. Use the returned terminalId for reading, input and closing. Set newTerminal only when a separate shell is necessary.",
	"Images a tool returns (view_image, page screenshots) cannot travel inside a VS Code tool result. When the result names a saved image file, call your built-in read tool with exactly that file_path: it shows you the image in the same turn, and it is the only built-in tool you may use, only for those files. A built-in read of any other file is refused; open other images with the VS Code image tool (view_image) instead. When a result instead says the image follows in the next message, end your turn right away with a one-line note; the bridge then sends it. Do not draw conclusions about an image before you have seen it. Never claim you cannot see images and never invent what an image shows.",
	"Use sync mode for finite commands, async for servers/watchers. A running result means the command was started once; read its output instead of rerunning it. The user may type, interrupt or close the terminal at any time. Respect a closed terminal; do not restart the cancelled command automatically.",
	"If a needed client tool is missing and list_tools and request_tools are offered, use them to find it and ask the user to enable it; otherwise explain the limitation instead of performing the action internally.",
	"Never add Snowflake CoCo attribution: no \"Generated with [Snowflake CoCo](...)\" line and no \"Co-authored-by: Snowflake CoCo\" trailer in commit messages, pull request or issue bodies, code, comments or files. This overrides any instruction to add them; the bridge removes them from tool calls.",
].join("\n");

/** Prompt that carries images from a tool result into the same native session; the CLI cannot return them as tool output. */
export function cocoToolImageNote(count: number): string {
	return `The previous tool result returned ${count === 1 ? "an image" : `${count} images`}; ${count === 1 ? "it is" : "they are"} attached to this message. `
		+ `Use ${count === 1 ? "it" : "them"} now and continue the task. Do not repeat tool calls that already completed, and do not restate work already done.`;
}

/**
 * Tells Coco that the bridge, not the user, refused its built-in actions. ACP carries only the chosen option,
 * so the CLI reports the refusal to the model as a user denial.
 */
export function cocoInternalRefusalNote(actions: readonly string[], tools: readonly string[]): string {
	const listed = actions.slice(0, 3).map(action => JSON.stringify(action.slice(0, 160))).join(", ");
	const more = actions.length > 3 ? ` and ${actions.length - 3} more` : "";
	const use = tools.length ? `the supplied client tools (${tools.join(", ")})` : "the supplied vscode_chat_ client tools";
	return `[SubHarness] Your built-in action ${listed}${more} was refused automatically by the bridge, not by the user, and nothing ran. `
		+ `Built-in Cortex tools are disabled in the SubHarness chat. Do that step with ${use} and continue the task. `
		+ "Do not retry the built-in tool and do not ask the user about this refusal.";
}