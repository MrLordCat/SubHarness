# SubHarness 2.1.0

A stable release that consolidates the 2.0.12 and 2.0.13 development builds.
A long chat now keeps its own context small instead of asking for a new one,
Claude gets several subscriptions like Codex, approvals can be given once per
kind of action, and subagents learn about a used-up limit before they start.

Earlier notes: [2.0.11](https://github.com/MrLordCat/SubHarness/blob/735491b20d8b60155738e0fcd96d40c9fe711540/docs/RELEASE_NOTES.md),
[2.0.10](https://github.com/MrLordCat/SubHarness/blob/92bb7436ad7b54ef57b4740914103b38362b6662/docs/RELEASE_NOTES.md),
[2.0.9](https://github.com/MrLordCat/SubHarness/blob/45c7d70994819938282a405b537762bceb05cac2/docs/RELEASE_NOTES.md),
[2.0.8](https://github.com/MrLordCat/SubHarness/blob/f32974ca423e04fc1ea7ee5b6ec2c3085e92f252/docs/RELEASE_NOTES.md),
[2.0.7](https://github.com/MrLordCat/SubHarness/blob/33675edc3537267930e58d6799931e6090269b2d/docs/RELEASE_NOTES.md),
[2.0.5, everything since 1.21.0](https://github.com/MrLordCat/SubHarness/blob/2aaade62a5422ee4ff4ae490441f3604424b1d0f/docs/RELEASE_NOTES.md).
Every change is listed in the [changelog](https://github.com/MrLordCat/SubHarness/blob/main/CHANGELOG.md).

## Upgrade notes

- 2.0.5 and later offer 2.1.0 at their next update check; Quick Access →
  **SubHarness** → **Install Update** installs it right away. Versions before
  2.0.5 need one manual install from
  https://github.com/MrLordCat/SubHarness/releases/latest
  (`llama-vscode-chat-v2.1.0-win32-x64.vsix` or
  `llama-vscode-chat-v2.1.0-linux-x64.vsix`), then **Developer: Reload
  Window**.
- Context cleaning is on by default: `llamacpp.chatContextBudget` is 200,000
  tokens, and 0 turns it off.
- **Allow without asking…** beside external tool groups is gone. It never
  stopped VS Code's own dialog for calls from this chat. Tools that may change
  something, such as MCP tools not marked read-only, still ask in that dialog.
- The 2.0.x patch releases leave the Releases page with this release; their
  notes stay reachable through the links above.

## A chat that cleans itself

- Over the budget, a new request first replaces stale tool results of earlier
  requests with a one-line stub (a file read that was edited or read again, a
  command or check that ran again, an old search or listing, a large result
  two requests old), then summarizes older turns, down to about 60% of the
  budget. Sizes are counted in the provider's own tokens.
- A **Context cleaned** card shows what left the context; the messages stay in
  the chat. The provider's session starts once from the cleaned history, so
  the cache is rebuilt once per cleaning.
- A model switch compacts the cleaned history only when it is still over
  `llamacpp.providerSwitchContextTokens`, and the cleaned history fits
  Claude's replay whole, with the chat's summary kept.
- The summary is written by DeepSeek, then a local llama.cpp model, then the
  chat model; an empty DeepSeek balance is remembered for 30 minutes.

## Subscriptions and limits

- **Several Claude subscriptions.** Quick Access → Claude → **Add Claude
  Account…** gives an account its own `CLAUDE_CONFIG_DIR`. The picker shows a
  group per account with its own limits, and subagents start on an account
  with room.
- **Continue on another subscription.** When a limit stops an answer and
  another account of the same provider has room, the limit card offers
  **Continue on Claude 2** or **Continue on Codex 2**.
- **Weekly limits.** The reset time comes from the provider's own report and
  understands dates, so auto-continue no longer wakes up into the same limit.
  The **Continue automatically after the reset** box stays on the card for a
  weekly limit, cleared; long waits read in days.

## Approvals

- **Always allow** on an approval card covers the kind of action, not one
  file or command line: every change outside the workspace, every folder
  deletion, or every command of one dangerous-command rule. Approvals hold in
  every workspace and are saved in the user setting
  `llamacpp.chat.alwaysAllow`.
- **Always allowed** at the end of the Tools list and the command
  **SubHarness: Manage Always Allowed Actions** show and revoke them. A command
  that matches several rules runs without a card only once all of them are
  allowed.

## Subagents and tools

- A subagent call to a model whose limit is used up on every account starts
  nothing and answers at once with the reset time and the models that can
  run, instead of `Unknown subagent model`.
- A subagent stops after 1000 tool rounds instead of 100.
- **`changes_diff`** returns a diff of the agent's changes from the Keep/Undo
  snapshots, for the running turn or everything waiting for Keep or Undo; a
  cheap reviewer subagent can call it.
- One bad tool call no longer ends the turn for local and API models: an
  argument the schema does not list is dropped when the call works without
  it, and a bad call next to good ones is skipped with a note the model can
  act on.

## Local server

- With the local server off, background probes back off from 15 seconds to
  5 minutes. A success, a changed server setting, **Refresh Models** or
  **Run Provider Health Check** resets the pause; a chat request always tries.

## Documentation

- The docs keep one current reference per topic. Finished plans, old audits
  and incident notes were removed, their valid facts moved into the reference
  documents, and the remaining texts no longer describe the removed Copilot
  Chat integration.
