# SubHarness 2.0.11

Subagents waste less. A DeepSeek subagent hits the prompt cache on every tool
round instead of rereading its prompt, and with two ChatGPT subscriptions a
Codex subagent starts on whichever one still has room.

Earlier notes: [2.0.10](https://github.com/MrLordCat/SubHarness/blob/92bb7436ad7b54ef57b4740914103b38362b6662/docs/RELEASE_NOTES.md),
[2.0.9](https://github.com/MrLordCat/SubHarness/blob/45c7d70994819938282a405b537762bceb05cac2/docs/RELEASE_NOTES.md),
[2.0.8](https://github.com/MrLordCat/SubHarness/blob/f32974ca423e04fc1ea7ee5b6ec2c3085e92f252/docs/RELEASE_NOTES.md),
[2.0.7](https://github.com/MrLordCat/SubHarness/blob/33675edc3537267930e58d6799931e6090269b2d/docs/RELEASE_NOTES.md),
[2.0.5, everything since 1.21.0](https://github.com/MrLordCat/SubHarness/blob/2aaade62a5422ee4ff4ae490441f3604424b1d0f/docs/RELEASE_NOTES.md).
Every change is listed in the [changelog](https://github.com/MrLordCat/SubHarness/blob/main/CHANGELOG.md).

## Upgrade notes

- 2.0.5 and later offer 2.0.11 at their next update check; Quick Access →
  **SubHarness** → **Install Update** installs it right away. Versions before
  2.0.5 need one manual install from
  https://github.com/MrLordCat/SubHarness/releases/latest
  (`llama-vscode-chat-v2.0.11-win32-x64.vsix` or
  `llama-vscode-chat-v2.0.11-linux-x64.vsix`), then **Developer: Reload
  Window**.
- With two or more ChatGPT accounts, Codex subagents are named without the
  account: `GPT-6-Luna (Codex)` instead of `GPT-6-Luna (Codex 2)`. The
  subagent card still shows the account a run used.

## Fixes

- **A DeepSeek subagent keeps its prompt cache.** Requests to deepseek-flash
  cached about 8–9k tokens of a 15–45k prompt: everything after the system
  prompt and task was read again on every tool round. A subagent has no
  conversation id of its own, so the provider picked the shared memory block
  again every round. Its query included the latest tool results, so the same
  entries came back in a different order right after the task. A subagent now
  gets memory once in its task message, like a chat message, and the provider
  adds no block of its own. The same run caches 92–98% from its second round.
- **The memory query reads only user messages.** Tool results no longer change
  which memory entries a request without a conversation id gets.

## Changes

- **Codex subagents use either subscription.** Before, only the active account
  offered subagents; once its 5-hour or weekly limit was used up, Luna and
  Terra left the subagent list although the second subscription had room. Now
  every signed-in account offers its models, the list shows each model once,
  and a subagent starts on the active account, or on the next account in list
  order (Codex 1, Codex 2…) while the active one is used up. A limit a request
  just hit counts at once, before the next usage report. A signed-out account
  offers no subagents.
- **An open subagent follows the room.** A subagent kept open with `keepOpen`
  whose account runs out or signs out continues its next task on the same
  model of another account and keeps its conversation.
