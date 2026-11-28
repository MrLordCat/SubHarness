# SubHarness 2.1.3

A patch release on the 2.1 line that also brings the 2.1.1 and 2.1.2
development builds. It works on the three goals of the line: a lighter
extension, fewer tokens per answer, and tools that agents use without
guessing. The VSIX shrinks from 115 MB to 10.6 MB, tool results fit what the
model takes in, and long subagent reports reach the agent whole.

Earlier notes: [2.1.0 and before](https://github.com/MrLordCat/SubHarness/blob/1d11dd2682eb41be560d7ae9c7f271c90b55def3/docs/RELEASE_NOTES.md).
Every change is listed in the [changelog](https://github.com/MrLordCat/SubHarness/blob/main/CHANGELOG.md).

## Upgrade notes

- 2.0.5 and later offer 2.1.3 at their next update check; Quick Access →
  **SubHarness** → **Install Update** installs it right away. Versions before
  2.0.5 need one manual install from
  https://github.com/MrLordCat/SubHarness/releases/latest
  (`llama-vscode-chat-v2.1.3-win32-x64.vsix` or
  `llama-vscode-chat-v2.1.3-linux-x64.vsix`), then **Developer: Reload
  Window**.
- The Claude runtime (`claude.exe`, about 100 MB) is no longer inside the
  VSIX. Signed-in Claude users get it in the background a few seconds after
  the update; otherwise Claude sign-in offers it, and **SubHarness: Install
  Claude Runtime** installs it. Quick Access shows **Claude Runtime: Not
  installed** while it is missing. The Claude Code extension's binary and
  `llamacpp.claudeCliPath` still come first.
- DeepSeek session state moves from one `session-state.json` to one file per
  conversation; the old file is split once and then deleted. DeepSeek
  reasoning moves from VS Code's state database to
  `deepseek-reasoning-map.json` in the extension's global storage.

## A lighter extension

- The VSIX is 10.6 MB instead of 115 MB. The extension loads from one bundled
  file (module loading takes about 104 ms instead of 225 ms), and unused SDK
  builds left the package.
- Nothing large is read at startup: the 68 MB DeepSeek session state used to
  be parsed twice, about 0.6 s. A conversation's state file is read the first
  time it is used.
- Provider usage is refreshed when it is needed instead of every minute; an
  idle window sent about 47 such requests an hour. The DeepSeek balance, Codex
  status and Claude usage refresh at startup, after requests, when Quick
  Access opens (at most every 5 minutes) and every 15 minutes otherwise; API
  catalog probes run every 15 minutes instead of 5.
- Storage is cleaned in the background: logs start a new file every 16 MB and
  stay under 60 MB, snapshot repositories are packed, and Cursor agents,
  provider transcripts and temp files unused for 30 days are removed. Chat
  logs are never removed.

## Fewer tokens

- Tools fit their output to what the model's provider takes in one result,
  instead of the provider dropping its middle. `read_file` stops early and
  names the `startLine` to continue from, the terminal tools return less of
  the newest output, and `changes_diff` names the files it left out.
- Subagent reports reach the agent whole, up to 60,000 characters, on Claude,
  Codex and HTTP models; Claude used to cut them to 16,000.
- Self-cleaning also removes old images and older copies of the memory index,
  shortens long `content`, `oldString`/`newString` and `prompt` arguments of
  earlier edits and subagent tasks, and counts the tool schemas in the budget.
- An open subagent is cleaned like the chat before its next task; its panel
  shows **Earlier tasks cleaned**.
- The system prompt is 605 characters shorter.
- Session Quality → **Request breakdown** shows what the first request of each
  turn spends its tokens on.

## Tools that agents use without guessing

- Every built-in tool schema lists exactly the arguments it takes. A call with
  an unknown argument still runs without it, and the result names the
  argument and the accepted ones, on Claude too.
- Errors say what to do next: a missing tool points to `list_tools` and
  `request_tools`, and edit, rename, binary-file, web, `run_checks` and
  round-limit errors name the fix.
- A terminal result in the state `running` says how to wait for it with
  `read_terminal` and `waitMs` instead of starting it again.

## Fixes

- A Codex window whose reset time has passed no longer counts as used up, and
  the Codex limit text names the window that blocks with its own percent.
