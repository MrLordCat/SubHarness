# Bridge chat (preview)

The extension's models and tools are available in its own **SubHarness chat**.
It talks to Codex, Claude, DeepSeek, custom APIs, local servers and Coco, and
runs its tools directly.

The chat lives in the secondary side bar: click its **SubHarness** icon there. The first start after the
update opens it once. If the secondary side bar is hidden, show it with the
layout button in the title bar or **View: Toggle Secondary Side Bar
Visibility**; VS Code then keeps it open across restarts. You can drag the
chat to the primary side bar or the panel like any other view. **SubHarness:
Open Chat in Editor** opens it as an editor tab. The side bar and the tab show
the same chat; a wide tab keeps the messages and the input in one centered
column. Quick Access stays in the **SubHarness** activity bar container.

## Writing a message

- **Enter** sends, **Shift+Enter** adds a line.
- Unsent text and attachments stay with their chat: they come back when you
  return to the chat and after VS Code reloads. A new chat that holds only
  such a draft stays in the history.
- You can write while the agent works. **Send** queues the message above the
  input, and the agent reads it after the tool calls it is running now. Several
  queued messages go out together; **×** removes one. **Stop** ends the answer
  and puts the queued messages back into the input.
- **Stop** shows as soon as a message is sent, also while the bridge still
  reads its attachments. Stopping then sends nothing and puts the text back
  into the input; deleting the chat then starts no request.
- When no model is available, a sent message is not lost: it comes back into
  the input with its attachments, and a notice says why. The same holds for
  queued messages whose delivery fails; in a chat you are not looking at they
  become its draft.
- The model picker groups models by provider and has a search box. Multiple
  Codex accounts each have their own group and limits. Each group
  shows that provider's 5-hour window, the weekly one only once it is used up,
  or its balance, fetched again when the picker opens or a model is picked. A provider with a used-up limit is dimmed with its reset
  time, and a warning above the input says so while one of its models is
  selected. While Codex or Claude is enabled but not signed in, the picker ends
  with **Sign in to Codex** or **Sign in to Claude**; Codex without a CLI
  downloads it first.
- **☆** next to a model in the picker stars it. Once a model is starred, the
  picker opens on the starred models, grouped by provider, plus the selected
  model; **Show all models** lists every model, and a search always looks
  through all of them. Stars are kept for every workspace, and a model that is
  missing for a while (signed out, offline) keeps its star. From the keyboard,
  **Ctrl+D** (**Cmd+D** on macOS) in the search box stars the highlighted model,
  and Tab moves through the stars without closing the list.
- **Thinking** appears for models with reasoning levels. The choice is
  remembered per model.
- **Tools** lists every tool the model may use. The bridge's own tools are on;
  tools of other extensions and MCP servers are off until you enable them.
  The choice is remembered. The **Allow without asking…** link beside an
  external tool group opens VS Code's **Manage Tool Approval** at profile scope.
  Mark a server or tool as always allowed there to stop its approval dialog.
  **SubHarness: Allow External Tools Without Asking** opens the same setting
  (also in the chat view's **…** menu).
- The limits chip shows the 5-hour window of the selected Codex or Claude
  subscription, the weekly window instead once it is used up, or the DeepSeek
  balance. Hover it for every window; click it for all providers and reset
  times.
- The counter on the right is the last request's prompt size against the
  model's full context window; its tooltip names the part reserved for the
  answer (32,768 tokens for Codex). Click it for two sliders. **Shared context** is the
  working context of Codex, Claude, Coco and Cursor, each capped by its model
  window. **Follow the Codex Sol window** uses the window of the newest Sol
  that Codex has catalogued or reported and disables the slider once known.
  **Model switch** is the most a model receives when it takes over
  a chat; a longer chat is compacted first (see Long chats). A value is saved
  when you release the slider and applies to new requests. The popup changes
  the same settings as **Provider Context** (`llamacpp.sharedContextLength`,
  `llamacpp.sharedContextFollowCodex`, `llamacpp.providerSwitchContextTokens`).
- **cache N%** is the share of prompt tokens the provider served from its
  prompt cache, summed over the selected model's turns since it took over the
  chat. It starts again after a model switch and updates after every request;
  hover it for token counts and the last request. Only requests that report
  cached tokens count. `cache n/a` means the provider does not report them.
  Coco reports its counters once, when its whole answer ends (tool rounds
  included), so during a Coco answer the label shows the earlier answers.

## Attachments

Click **+** to attach the editor selection, the active file, an open editor, a
workspace file or any file on disk. You can also Shift+drag files from the
Explorer onto the input, or use **Add Selection to Chat** in the editor context
menu and **Add File to Chat** in the Explorer context menu.

**Ctrl+V** pastes a screenshot, or files copied in the system file manager,
as attachments; files dragged from the file manager work the same way. Text
that comes with a picture of itself, such as a spreadsheet range, pastes as
text. Pasted files are saved in the extension's storage and kept for 30 days;
each can be up to 20 MB, ten at a time.

Attachments show as chips above the input and under the sent message; click
one to open it. While a sent message is being edited, what you paste, drop or
pick goes to the box you used: the edit box or the input at the bottom. The
**Add Selection to Chat** and **Add File to Chat** commands go to the edit box
while one is open. Files are read when the message is sent, including unsaved
editor content. Each file is capped at 60,000 characters and a message at
150,000; binary files and files over 2 MB are named but not included. The
chip of a file the model did not get shows **⚠**; hover it for the reason.
Images (PNG, JPEG, GIF or WebP up to 3.75 MB) go to models that accept images
after the message text; other models get a note that they were left out.

## Tools and approvals

The chat's own tools read, search, create, edit (`replace_string_in_file`,
`multi_replace_string_in_file`) and delete files, show images to the model
(`view_image`: PNG, JPEG, GIF or WebP up to 3.75 MB), run terminals, fetch web
pages (`fetch_webpage`), work with symbols through the language servers
(`list_code_usages`, `rename_symbol`, `workspace_symbols`), report problems and
start subagents. Images returned by MCP and extension tools also reach the
model; the chat shows their name and size, and a click on that line opens the
image in VS Code's image viewer. `send_to_terminal` with
`interrupt: true` stops the running command with Ctrl+C. Relative paths in tool
calls start from the first workspace folder.

Each chat and each subagent has its own terminals, and reuses an idle one. A
terminal whose sync command timed out and printed nothing for a minute is
closed before a new one opens; each chat or subagent can have at most four.
A subagent's idle terminals close when it finishes, or for an open subagent
when it is closed.

A turn has no limit on tool rounds: it runs until the model answers without a
tool call or you press **Stop**. A subagent stops after 100 tool rounds.

When an answer used tools, its text after the last tool round is shown in a
separate **Answer** block with a tinted background, apart from the commentary
between the tool calls. It appears once the answer is complete; an answer
without tools is shown as usual.

For longer work the agent keeps a todo list (`manage_todo_list`), shown above
the input as **Todos done/total**; click it for the whole list. With
`ask_questions` the agent asks you up to five questions in a card above the
input and waits: pick an option, type an answer, or **Skip**. Sending a message
instead also skips the questions, and the agent reads your message next.

The agent can also look for tools you have not turned on; its instructions
tell it to do so when the enabled tools are not enough. `list_tools` shows
every tool the chat can offer, including disabled MCP and extension tools, and
`request_tools` asks you to enable some of them: a card lists the tools with
the agent's reason, all checked. **Enable** turns on the ones you leave
checked; **Deny** turns on none. Enabled tools stay on, as if you had switched
them on in the Tools picker. Codex, DeepSeek and other HTTP models can use them
in the same answer. Claude, Coco and Cursor models get them with your next
message; Claude then continues its session with the new tools instead of
starting over.

## Memory

The chat gives every model the bridge's shared memory, whatever the provider.
Each message you send carries a `<memory>` block with the index of entries for
this project and the global ones, the pinned entries and the entries that match
the message. Later messages carry only what changed since then, so earlier
requests stay the same and the provider's prompt cache keeps working. The agent
saves, searches and deletes entries with the `llamacpp_*_memory` tools without
asking. The settings `llamacpp.memoryEnabled` and `llamacpp.memoryAutoInject`
turn this off.

The book button in the chat header opens the memory panel: the entries of this
project and the global ones, with search and a scope filter. Click an entry to
read it, then **Edit**, **Pin**/**Unpin** or **Delete**; **New** adds an
entry. Pinned entries reach the model with every new chat.

The model runs tools without asking, with one exception: a terminal command
that matches a rule in `llamacpp.chat.dangerousCommands` waits for your
approval in the chat. The default rules cover force pushes, hard resets,
recursive deletes, disk formatting, publishing packages and similar commands.
Edit the list in Settings; each entry is a regular expression. `delete_file`
also asks before it deletes a folder or anything outside the workspace.

The SubHarness chat offers its built-in tools and tools from MCP servers and
other extensions in the **Tools** picker. External tools are off until enabled;
VS Code may ask in a modal dialog before running them.

## Changed files: Keep and Undo

Files the agent changes are listed above the input. Open one to see its diff,
then **Keep** or **Undo** single files or all of them. Undo restores a file only
while it still holds the agent's version, so later edits by hand survive.

The list updates after tool calls that may write. After you press **Stop**,
the chat shows **Stopping…** while it saves the final file list. **Keep** and
**Undo** unlock when **Stopped.** appears.

The bridge records changes with a private git snapshot of the workspace
folders in the extension's storage. The snapshot before the first tool that
may write includes files that already exist, including untracked files.
Ignored files are also recorded up to a limit, excluding build and dependency
folders (`node_modules`, `out`, `dist`, `build`, `target`, `.vscode-test`, `.venv`
and similar) and ignored files over 1 MB.

When two chats work at the same time, a chat lists only the files its own
edit tools wrote, and says how many other changed files it left out. Undo in
one chat therefore cannot revert another chat's work. Do not let two chats
edit the same file.

## Reading the chat

- When you scroll up, **↓** at the bottom right takes you back to the latest
  message; a dot on it means a new message or more of the answer arrived.
- **Copy** under an answer copies its text as Markdown; **⧉** next to a sent
  message copies that message. Hovering an answer shows when it was written,
  and the tooltip of a sent message shows when it was sent.
- A sent message longer than twelve lines or 800 characters is folded;
  **Show more** unfolds it.
- File links in answers open the file. This includes Markdown links
  (`[report](docs/report.md#L12)`), `file:` links and file paths in inline
  code (`src/chat/index.ts:40`). A line or range opens the file there, and a
  folder reveals itself in the Explorer. A path that is not in a workspace
  folder is searched by its tail. Several matches ask which one to open. When
  the chat is an editor tab, the file opens in another editor group. Inline
  code counts as a path only when it ends in a known file extension, so code
  identifiers such as `Promise.all` stay plain text.

## Editing a sent message

Click a sent message, or press **↑** in the empty input, to edit it (↑ opens
the last one). The editor has the same controls as the
input: model, thinking level, tools and attachments. Sending replaces that
message and everything after it. If the agent changed files since then, a
checkbox also undoes those changes; if they cannot be undone, the message and
the chat stay as they were and an error says why. **Escape** or **Cancel**
closes the editor.

## Chat history and background chats

Click the chat title, or the history button in the view title, to search
earlier chats grouped by day, open one, start a new chat or delete one.
Arrow keys, Enter and Delete work from the search box; Escape closes the list. A chat keeps its model
when you return to it. A chat you leave without sending anything is removed.

**✎** in a row renames the chat: Enter or a click elsewhere saves, Escape
cancels, and an empty name brings the automatic title back. A chosen name stays
when the chat goes on or a message is edited. **⤓** exports the chat to a
Markdown file: every message with its text, attached files and tool names,
without thinking and tool output.

Opening another chat does not stop a running answer. Several chats can run at
the same time. The header badge counts chats that are running (●), waiting for
an approval (!) or finished while you were elsewhere (✓). When a background
chat needs an approval, a notification offers to open it. **Stop** stops only
the chat you are looking at; deleting a running chat stops it first.

While the VS Code window is not focused or is minimized, the operating system
announces a finished turn, an approval request and a question (a toast on
Windows, Notification Center on macOS, `notify-send` on Linux). On Windows,
clicking the notification focuses the VS Code window that ran the chat and opens
that chat. The first click may show VS Code's one-time **Allow 'SubHarness'
extension to open this URI?** prompt; select **Do not ask me again**. Set
`llamacpp.chat.systemNotifications` to `false` to turn notifications off.

## Subagents

The `subagent` tool lets the model hand a self-contained task to a cheaper
model from the bridge's subagent list. The task runs with the same tools, but
without its own subagents. The main agent's independent tool calls from the
same model response can run while the subagent works. The model receives all
results before its next response. The subagent card shows the model, the
task and the current step. Expand it for the prompt, steps and report.

While the tool is offered, the main agent's system prompt carries a short
delegation guide: plan the task, delegate routine steps to the cheapest model
that fits, do tiny steps itself, write self-contained prompts, review every
report, send fixes with `subagentId` and close accepted subagents, fall back to
a model of similar size and agree on large plans first. Subagents do not get
it; repository instructions such as `AGENTS.md` take precedence.

With `keepOpen` the subagent stays open after its report, with its own
conversation. The model checks the work and either closes it with
`close_subagent` or sends the same subagent a follow-up task with its id
(`subagentId`), as often as needed; the subagent keeps its model, context and
terminals. Each new request tells the model which subagents are open, so a
long chat does not lose them. **Open subagents** above the input lists them
with their model, what they are doing or their last task and report; **×**
closes one that is not working. Open subagents are saved with the chat and
survive a reload. A chat keeps at most six; when a subagent's context fills
up, its older tool output is shortened, and near the limit the model is told
to close it and start a new one.

From Codex the list offers only the newest 6.x Luna and the newest 6.x Terra
of the ChatGPT subscription (now GPT-6-Luna and GPT-6.1 Terra): Luna for small,
well-defined steps such as an edit in one or two files, a search or a test run,
Terra for larger multi-step steps such as a change across several files with
its tests. 5.x models and Sol are never subagents, so an account without 6.x
models has no Codex subagent.

Models from API profiles (Cursor and other OpenAI-compatible gateways) are
listed last and marked as paid per use; local llama.cpp servers stay in the
local group.

## Long chats

A chat keeps its newest 1,000 requests and their answers. Older requests are
deleted from the chat and its log when the chat is opened or VS Code starts.
Nothing is deleted by age; what the model sees is still limited by compaction.

When another model takes over a chat that is larger than
`llamacpp.providerSwitchContextTokens` (default 250,000 tokens), older turns
are summarized first, down to about 110,000 tokens or half the limit if that is
lower. The newest turns stay verbatim while they fit. The turn that does not
fit whole keeps its request and the newest tool rounds of its answer; only its
earlier rounds go into the summary, so one long task is not reduced to a
summary. Tool results longer than 12,000 characters in the kept turns before
your latest message reach the model as their first 8,000 and last 3,800
characters.

A DeepSeek model writes the summary (up to 32,000 characters) when a DeepSeek
API key is configured. Without a key, or when DeepSeek fails (for example an
empty balance), the model taking the chat over writes it from the same prompt,
without tools; if that fails too, the bridge builds an extract of the older
turns. The summary also carries your summarized requests verbatim (up to 2,000
characters each and 12,000 in total; when there are more, the first and the
newest stay) and names the chat's log file, so the model can look up details
it left out.

A card in the answer shows what was summarized, who wrote the summary, why a
fallback was used, and your requests.

The chat window renders only the visible messages. Long tool output and long
thinking text reach the window as short previews and load in full when you
expand them.

## Limits, errors and interruptions

When a subscription limit or an empty balance stops a request, the answer shows
when the limit resets and a **Choose another model** button. A failed answer
has **Retry**, which continues the answer instead of starting it over: its
text, tool results and file changes stay in the chat and in Keep/Undo, and the
bridge sends the model a continuation message with the error that stopped it.
The chat shows that message as a one-line marker; it cannot be edited. Coco
continues its saved native session; the model gets the failed answer's tool
rounds in the history. To start the request over instead, edit your message.

When the 5-hour Codex or Claude window stops an answer, the chat continues it
by itself a minute after the reset, the same way Retry does, with the chat's
model. This also works for a chat in the background and after VS Code reloads;
a continuation that came due while VS Code was closed runs shortly after start
unless it is more than a day old. The limit card shows **Continue
automatically after the reset** with the time; clear it to wait for you
instead. Sending a message or pressing Retry yourself replaces the pending
continuation. After three continuations in a row that hit the limit again,
auto-continue stops until you tick the box again. Weekly limits and empty
balances are not continued.

If VS Code closes or reloads while an answer runs, the chat reopens with a
note that the answer was interrupted, and **Retry**, which continues it the
same way. Files changed by an interrupted turn are not listed for Keep/Undo;
the changes panel says so.

## Commands

| Command | Where |
| --- | --- |
| SubHarness: New Chat | Chat view title |
| SubHarness: Show Chats | Chat view title |
| SubHarness: Open Chat in Editor | Chat view title |
| SubHarness: Allow External Tools Without Asking | Chat view **…** menu |
| SubHarness: Add Selection to Chat | Editor context menu |
| SubHarness: Add File to Chat | Explorer context menu |

## Where chats are stored

Chats are saved per workspace in the extension's workspace storage:
`chat-sessions` holds one JSONL log per chat and an index, `chat-changes`
holds the Keep/Undo state and the private snapshots, and `chat-attachments`
holds pasted files. Images sent with a message are kept in its chat log.
Drafts are kept in the workspace state.

## Checking the chat's look

`node scripts/build-webview.mjs --harness` builds a browser harness of the
chat with a fake host in `artifacts/chat-harness/`. Its URL takes `theme`
(`dark`, `dark-plus`, `abyss`, `light`, `hc-dark`, `hc-light`), `host=editor`
and `count` (number of messages). `node scripts/chat-harness-shots.mjs` opens it
in headless Edge or Chrome and saves screenshots of fixed scenarios (light
theme errors, the cards, a wide editor tab, a 320 px sidebar with its popups)
to `artifacts/screens/`; `--only=name,name` picks scenarios. It shows no
dialogs, so an agent can run it unattended.
