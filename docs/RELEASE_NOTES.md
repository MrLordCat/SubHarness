# SubHarness 2.0.10

A long chat on DeepSeek or another HTTP provider stays within its context
budget and hits the prompt cache again. Before this fix the provider received
the whole saved chat instead of the chat's compacted history, compacted it
again on every request and missed the cache each time.

Earlier notes: [2.0.9](https://github.com/MrLordCat/SubHarness/blob/45c7d70994819938282a405b537762bceb05cac2/docs/RELEASE_NOTES.md),
[2.0.8](https://github.com/MrLordCat/SubHarness/blob/f32974ca423e04fc1ea7ee5b6ec2c3085e92f252/docs/RELEASE_NOTES.md),
[2.0.7](https://github.com/MrLordCat/SubHarness/blob/33675edc3537267930e58d6799931e6090269b2d/docs/RELEASE_NOTES.md),
[2.0.5, everything since 1.21.0](https://github.com/MrLordCat/SubHarness/blob/2aaade62a5422ee4ff4ae490441f3604424b1d0f/docs/RELEASE_NOTES.md).
Every change is listed in the [changelog](https://github.com/MrLordCat/SubHarness/blob/main/CHANGELOG.md).

## Upgrade notes

- 2.0.5 and later offer 2.0.10 at their next update check; Quick Access →
  **SubHarness** → **Install Update** installs it right away. Versions before
  2.0.5 need one manual install from
  https://github.com/MrLordCat/SubHarness/releases/latest
  (`llama-vscode-chat-v2.0.10-win32-x64.vsix` or
  `llama-vscode-chat-v2.0.10-linux-x64.vsix`), then **Developer: Reload
  Window**.
- The first request of a long chat after the update sends a smaller,
  different history, so it misses the prompt cache once.

## Fixes

- **The chat's compaction reaches the provider.** The common journal restored
  messages the chat had compacted away. It is a leftover from the Copilot Chat
  integration removed in 2.0.8. A chat compacted to 107k tokens on a switch to
  DeepSeek arrived as 1.7M. Every provider now receives the chat's own
  messages. The journal remains the transcript that prompts link to, and still
  records which model answered last.
- **One compaction lands under the budget.** A compaction kept 75% of its
  input even far over the budget. One request then made up to three DeepSeek
  summaries (1.7M → 1.3M → 0.9M → 0.68M), and an overflow retry sent 713k
  tokens against a 475k budget. Proactive and overflow compaction now keep
  the configured share (75% by default) of the smaller of the current size
  and the soft input target.
- **The tool-result fallback is remembered.** When a server rejects tool-role
  results, the request falls back to user-style results. Every later request
  of that chat repeated the rejected attempt. Its saved snapshot, in user
  format, no longer matched, so the history was compacted again on every
  request. The fallback now holds for the chat until the window reloads.
- **The log shows why a request failed.** `chat.request.error`,
  `chat.request.final_error` and `chat.tool_result_mode.fallback` include the
  first 500 characters of the server's error text.
