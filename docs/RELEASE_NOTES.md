# SubHarness 2.0.8

SubHarness no longer integrates with GitHub Copilot Chat: its models and tools
work in the SubHarness chat only. This release also brings notifications that
return to the right window, a shortcut to stop VS Code's approval dialogs for
external tools, and fixes for attachments and the input row.

Earlier notes: [2.0.7](https://github.com/MrLordCat/SubHarness/blob/33675edc3537267930e58d6799931e6090269b2d/docs/RELEASE_NOTES.md),
[2.0.6](https://github.com/MrLordCat/SubHarness/blob/0263e7daa802514418e6fc673aa4e4084952e56e/docs/RELEASE_NOTES.md),
[2.0.5, everything since 1.21.0](https://github.com/MrLordCat/SubHarness/blob/2aaade62a5422ee4ff4ae490441f3604424b1d0f/docs/RELEASE_NOTES.md).
Every change is listed in the [changelog](https://github.com/MrLordCat/SubHarness/blob/main/CHANGELOG.md).

## Upgrade notes

- The extension's models no longer appear in Copilot Chat's or the Agents
  window's model picker. Use the SubHarness chat in the secondary side bar.
- Removed: the Copilot Chat, workbench terminal and agent-host thinking
  patches with their commands and the Patches group in Quick Access; the
  settings `llamacpp.autoPatchCopilot`, `workbenchTerminalPatchEnabled`,
  `agentHostThinkingPatchEnabled`, `agentHistoryRounds`, `agentHistoryTurns`,
  `journalRenderRounds` and `journalRenderTurns`; the commands Continue Latest
  Codex Thread / Claude Session in New Chat, Choose Chat Model and Choose
  Model by Provider. Patches already applied to a VS Code installation stay
  until the next VS Code update replaces them.
- The extension contributes no VS Code language model tools any more. The
  memory tools are the chat's own tools now, with the same names.
- The first request of each provider after the update misses the prompt cache
  once, because the system prompts now name the SubHarness chat as the host.
- 2.0.5 and later offer 2.0.8 at their next update check; Quick Access →
  **SubHarness** → **Install Update** installs it right away. Versions before
  2.0.5 need one manual install from
  https://github.com/MrLordCat/SubHarness/releases/latest
  (`llama-vscode-chat-v2.0.8-win32-x64.vsix` or
  `llama-vscode-chat-v2.0.8-linux-x64.vsix`), then **Developer: Reload
  Window**.

## Notifications open the right window

On Windows, clicking the system notification of a finished turn, an approval
request or a question focuses the VS Code window that ran the chat and opens
that chat, instead of starting a new VS Code window. The first click may show
VS Code's one-time "Allow 'SubHarness' extension to open this URI?" prompt.

## Fewer approval dialogs for external tools

**Allow without asking…** next to the tool picker's groups of other
extensions' and MCP tools, and the command **SubHarness: Allow External Tools
Without Asking** (also in the chat view's **…** menu), open VS Code's Manage
Tool Approval at profile scope. Marking a server such as Playwright as always
allowed there stops the dialog that popped up before each of its tool calls.

## Fixes

- A screenshot or file pasted, dropped or picked in the input while a sent
  message was being edited no longer lands in that message's edit box: it goes
  to the box you used.
- In the edit box of a sent message, a picker that opens downward is no longer
  hidden under the following messages, and clicks reach it.
- When the input's bottom row does not fit on one line, the pickers stay on
  the first line and the second line has the limit chip, cache hit and
  context counter on the left and the buttons on the right.
