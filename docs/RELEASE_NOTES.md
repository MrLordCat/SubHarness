# SubHarness 2.0.5

AI Agent Bridge is now called SubHarness. Its own agent chat in the VS Code
secondary side bar is the main place to work with your models and tools. These
notes summarize versions 1.21.1 through 2.0.5 since the 1.21.0 stable release.

## Upgrade notes

- The repository is now `MrLordCat/SubHarness`, formerly
  `MrLordCat/ai-agent-bridge`; old links redirect to the new address.
- Versions before 2.0.5 cannot update automatically across the rename. Install
  2.0.5 once by hand from
  https://github.com/MrLordCat/SubHarness/releases/latest, choosing
  `llama-vscode-chat-v2.0.5-win32-x64.vsix` or
  `llama-vscode-chat-v2.0.5-linux-x64.vsix`, then run **Developer: Reload
  Window**. Version 2.0.5 and later find updates under both repository names.
- The extension id `mrlordcat.llama-vscode-chat`, settings, `llamacpp.*`
  commands and saved chats remain unchanged. Quick Access stays in the activity
  bar; the chat moves to the secondary side bar.
- Each chat keeps its newest 1,000 requests and answers. Older entries are
  deleted from the chat and its log when the chat opens or VS Code starts;
  entries are not deleted by age.

## Chat

- Use the chat in the side bar or open it in an editor tab. Choose Codex,
  Claude, Coco, Cursor, DeepSeek or local models in a searchable picker grouped
  by provider. Star favorites and choose a thinking level where available.
- Search, switch, rename, export or delete chats from the history. Chats and
  drafts, including attachments, survive a reload. Several chats can work in
  the background; badges show running, waiting and unseen finished chats.
- Send a message while an agent works to queue it after the current tool calls.
  Remove queued messages before delivery; Stop returns them to the input.
  Failed delivery also restores the message.
- Attach selections, open editors, workspace files or other files, including
  by paste and drag. Supported images reach models that accept them. Attachment
  chips show failures and open the attached file or lines.
- Edit a sent message with the full composer and optionally undo later file
  changes. Copy messages and answers, jump to the latest message and expand
  long messages, tool results and subagent steps.
- File links and paths in answers open files at the indicated line; folder
  links reveal folders in Explorer. A matching bare filename opens directly or
  offers a choice. Images in tool results open in the image viewer.
- Desktop notifications can announce a completed chat, approval or question
  while VS Code is unfocused or minimized. Disable them with
  `llamacpp.chat.systemNotifications`.

## Tools and changes

- The chat has tools for files, search, diagnostics, terminals, web pages,
  images and language-server operations. The searchable Tools picker enables
  groups; the agent can ask you to enable additional available tools.
- Commands matching `llamacpp.chat.dangerousCommands` require Allow or Deny,
  as do file edits outside the workspace and folder deletions. Stop denies a
  pending approval. Other chat and bridge tools run directly.
- The changed-files panel shows diffs as work progresses. Keep or Undo all
  changes or individual files; Undo preserves later manual edits. Changes
  survive reloads and stay separate when chats run concurrently. Git is needed
  for change tracking.
- Subagents can take on tasks with their own tools and show their progress and
  report in the chat. Their changes join Keep/Undo and dangerous commands need
  approval. Open subagents retain context for follow-up tasks and survive a
  reload; you can close them from the chat.
- Agent todos appear above the input and questions appear in cards. Terminals
  belong to their chat or subagent and reuse idle terminals.
- Stop shows a stopping state while changes are saved. Retry continues an
  interrupted or failed answer with its work and file changes intact.

## Providers

- Sign in to Codex and Claude from the model picker when needed. Codex can
  download and install the official CLI if none is available; Quick Access and
  Providers Manager can install or update it. Claude sign-in uses the bundled
  Claude Code CLI; signing out also signs Claude Code out on this computer.
- Codex subagents use the newest available Luna and Terra models in the 6.x
  family. Multiple Codex accounts keep their own available subagent models.
- Coco receives images returned by tools. Its sessions refresh changed
  instructions, recover after the CLI exits, and avoid repeated automatic
  Snowflake sign-in checks. Denied built-in actions can leave the turn running
  so Coco can use the chat tools.
- Subagent choices distinguish local models, DeepSeek and other API profiles.

## Context and memory

- The chat supplies workspace and project instructions, the open file and
  selection, and shared memory to providers. The memory panel lets you search,
  add, edit, pin and delete project and global entries.
- When another model takes over a long chat, older context is summarized while
  the full history remains visible. The compaction card shows the summary and
  its source; recent tool rounds and your requests are retained. If DeepSeek
  cannot summarize, the incoming model can do so, with an extract as fallback.
- Click the context counter to adjust shared context and model-switch limits or
  follow the Codex Sol window. The counter shows the model's full window and
  its tooltip shows the answer reserve.

## Usage and reliability

- The composer and model picker show provider limits or balance, with reset
  details. A limit card offers another model; after a five-hour Codex or Claude
  limit, the chat can resume automatically after reset, including after reload.
- A prompt-cache indicator shows the selected model's cache use since it took
  over the chat. Coco's cache counters and Claude's usage reporting are more
  accurate.
- Long chats and tool output load more efficiently. Interrupted answers can
  be retried after a reload, and the changes panel reports when it could not
  list files from an interrupted turn.

