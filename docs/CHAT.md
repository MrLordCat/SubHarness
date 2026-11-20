# Bridge chat (preview)

The extension has its own chat, independent of Copilot Chat. It talks to the
same models (Codex, Claude, DeepSeek, custom APIs, local servers, Coco) and
runs its own tools directly.

Open it from the **AI Agent Bridge** activity bar container → **Chat**, or run
**AI Agent Bridge: Open Chat in Editor** for an editor tab. The sidebar and the
tab show the same chat.

## Writing a message

- **Enter** sends, **Shift+Enter** adds a line.
- You can write while the agent works. **Send** queues the message above the
  input, and the agent reads it after the tool calls it is running now. Several
  queued messages go out together; **×** removes one. **Stop** ends the answer
  and puts the queued messages back into the input.
- The model picker groups models by provider and has a search box. Each group
  shows that provider's limits or balance, fetched again when the picker opens
  or a model is picked. A provider with a used-up limit is dimmed with its reset
  time, and a warning above the input says so while one of its models is
  selected.
- **Thinking** appears for models with reasoning levels. The choice is
  remembered per model.
- **Tools** lists every tool the model may use. The bridge's own tools are on;
  tools of other extensions and MCP servers are off until you enable them.
  The choice is remembered.
- The limits chip shows the most used Codex or Claude window or the DeepSeek
  balance of the selected provider. Click it for all providers and reset times.
- The counter on the right is the last request's prompt size against the
  model's context window.
- **cache N%** is the share of prompt tokens the provider served from its
  prompt cache, summed over the selected model's turns since it took over the
  chat. It starts again after a model switch and updates after every request;
  hover it for token counts and the last request. `cache n/a` means the
  provider does not report cached tokens.

## Attachments

Click **+** to attach the editor selection, the active file, an open editor, a
workspace file or any file on disk. You can also Shift+drag files from the
Explorer onto the input, or use **Add Selection to Chat** in the editor context
menu and **Add File to Chat** in the Explorer context menu.

Attachments show as chips above the input and under the sent message; click
one to open it. Files are read when the message is sent, including unsaved
editor content. Each file is capped at 60,000 characters and a message at
150,000; binary files and files over 2 MB are named but not included.

## Tools and approvals

The chat's own tools read, search, create, edit (`replace_string_in_file`,
`multi_replace_string_in_file`) and delete files, show images to the model
(`view_image`: PNG, JPEG, GIF or WebP up to 3.75 MB), run terminals, fetch web
pages (`fetch_webpage`), work with symbols through the language servers
(`list_code_usages`, `rename_symbol`, `workspace_symbols`), report problems and
start subagents. Images returned by MCP and extension tools also reach the
model; the chat shows their name and size.

For longer work the agent keeps a todo list (`manage_todo_list`), shown above
the input as **Todos done/total**; click it for the whole list. With
`ask_questions` the agent asks you up to five questions in a card above the
input and waits: pick an option, type an answer, or **Skip**. Sending a message
instead also skips the questions, and the agent reads your message next.

The model runs tools without asking, with one exception: a terminal command
that matches a rule in `llamacpp.chat.dangerousCommands` waits for your
approval in the chat. The default rules cover force pushes, hard resets,
recursive deletes, disk formatting, publishing packages and similar commands.
Edit the list in Settings; each entry is a regular expression. `delete_file`
also asks before it deletes a folder or anything outside the workspace.

Tools that only work inside Copilot Chat or a VS Code chat session are not
offered: every tool of the Copilot Chat extension (`copilot_*`, its subagents
and skills) and the VS Code chat tools for questions, todo lists, chat
terminals, tasks and the integrated browser. Tools of MCP servers and other
extensions stay available in the **Tools** picker.

## Changed files: Keep and Undo

Files the agent changes are listed above the input. Open one to see its diff,
then **Keep** or **Undo** single files or all of them. Undo restores a file only
while it still holds the agent's version, so later edits by hand survive.

The list updates after every tool call that may write, so it grows while the
agent works; Keep and Undo unlock when the answer ends.

The bridge records changes with a private git snapshot of the workspace
folders in the extension's storage; your repository is not touched. Files your
`.gitignore` excludes are recorded too, except build and dependency folders
(`node_modules`, `out`, `dist`, `build`, `target`, `.vscode-test`, `.venv` and
similar) and ignored files over 1 MB.

When two chats work at the same time, a chat lists only the files its own
edit tools wrote, and says how many other changed files it left out. Undo in
one chat therefore cannot revert another chat's work. Do not let two chats
edit the same file.

## Editing a sent message

Click a sent message to edit it. The editor has the same controls as the
input: model, thinking level, tools and attachments. Sending replaces that
message and everything after it. If the agent changed files since then, a
checkbox also undoes those changes. **Escape** or **Cancel** closes the editor.

## Chat history and background chats

Click the chat title, or the history button in the view title, to search
earlier chats grouped by day, open one, start a new chat or delete one.
Arrow keys, Enter, Delete and Escape work in the list. A chat keeps its model
when you return to it. A chat you leave without sending anything is removed.

Opening another chat does not stop a running answer. Several chats can run at
the same time. The header badge counts chats that are running (●), waiting for
an approval (!) or finished while you were elsewhere (✓). When a background
chat needs an approval, a notification offers to open it. **Stop** stops only
the chat you are looking at; deleting a running chat stops it first.

## Subagents

The `subagent` tool lets the model hand a self-contained task to a cheaper
model from the bridge's subagent list. The task runs with the same tools, but
without its own subagents. Its card shows the model, the task and the current
step; expand it for the prompt, every step and the report.

## Long chats

When another model takes over a chat that is larger than
`llamacpp.providerSwitchContextTokens` (default 250,000 tokens), older turns
are summarized first, down to about 110,000 tokens or half the limit if that is
lower. A DeepSeek model writes the summary when a DeepSeek API key is
configured; otherwise the bridge builds a shorter extract of the older turns.
A card in the answer shows what was summarized.

The chat window renders only the visible messages. Long tool output and long
thinking text reach the window as short previews and load in full when you
expand them.

## Limits, errors and interruptions

When a subscription limit or an empty balance stops a request, the answer shows
when the limit resets and a **Choose another model** button. A failed answer
has **Retry**, which sends the same message again with its attachments.

If VS Code closes or reloads while an answer runs, the chat reopens with a
note that the answer was interrupted, and **Retry**. Files changed by an
interrupted turn are not listed for Keep/Undo; the changes panel says so.

## Commands

| Command | Where |
| --- | --- |
| AI Agent Bridge: New Chat | Chat view title |
| AI Agent Bridge: Show Chats | Chat view title |
| AI Agent Bridge: Open Chat in Editor | Chat view title |
| AI Agent Bridge: Add Selection to Chat | Editor context menu |
| AI Agent Bridge: Add File to Chat | Explorer context menu |

## Where chats are stored

Chats are saved per workspace in the extension's workspace storage:
`chat-sessions` holds one JSONL log per chat and an index, and `chat-changes`
holds the Keep/Undo state and the private snapshots.
