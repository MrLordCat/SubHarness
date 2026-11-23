# SubHarness 2.0.9

Agents in the SubHarness chat work faster: the main agent can run several
subagents in parallel or in the background, every subagent report lists the
files it changed, project checks run through one tool with a short summary,
and edit results show the errors an edit introduced. Retry now tells the model
what the interrupted attempt already did.

Earlier notes: [2.0.8](https://github.com/MrLordCat/SubHarness/blob/f32974ca423e04fc1ea7ee5b6ec2c3085e92f252/docs/RELEASE_NOTES.md),
[2.0.7](https://github.com/MrLordCat/SubHarness/blob/33675edc3537267930e58d6799931e6090269b2d/docs/RELEASE_NOTES.md),
[2.0.5, everything since 1.21.0](https://github.com/MrLordCat/SubHarness/blob/2aaade62a5422ee4ff4ae490441f3604424b1d0f/docs/RELEASE_NOTES.md).
Every change is listed in the [changelog](https://github.com/MrLordCat/SubHarness/blob/main/CHANGELOG.md).

## Upgrade notes

- 2.0.5 and later offer 2.0.9 at their next update check; Quick Access →
  **SubHarness** → **Install Update** installs it right away. Versions before
  2.0.5 need one manual install from
  https://github.com/MrLordCat/SubHarness/releases/latest
  (`llama-vscode-chat-v2.0.9-win32-x64.vsix` or
  `llama-vscode-chat-v2.0.9-linux-x64.vsix`), then **Developer: Reload
  Window**.
- The main agent's system prompt has a longer delegation guide, so the first
  request of a chat with the `subagent` tool misses the prompt cache once.
- New setting `llamacpp.chat.diagnosticsAfterEdit` (on by default).

## Parallel and background subagents

- Several `subagent` calls in one response run in parallel, up to three at a
  time.
- With `background: true` a subagent starts and the call returns at once; the
  main agent keeps working and collects the report with the new
  `wait_subagents` tool. The turn lasts until its background subagents finish,
  so Keep/Undo, approvals and **Stop** cover them. Reports that were not
  collected arrive as one automatic message after the answer.
- A report ends with **Files changed by this subagent**: each file its tools
  wrote, with added and removed lines.

## Checks and diagnostics

- `run_checks` runs the package scripts `compile`/`build`, `lint` and `test`
  (or the checks in `.subharness/checks.json`) without a terminal and returns
  each check's status, the mocha, TypeScript and ESLint failures, and the path
  of the full log. Checks matching a dangerous-command rule ask for approval.
- After `create_file`, `replace_string_in_file` and
  `multi_replace_string_in_file` the result lists up to 10 errors the edit
  introduced.

## Terminals

- A command waiting at a prompt such as `(y/n)`, `password:` or `Press Enter`
  returns early with the state `waiting for input` instead of hanging until
  the timeout.
- Progress bars and spinners are reduced to their last state, and repeated
  lines to one line with a count.
- An unknown terminal ID error says why the terminal is gone and lists the
  live terminals.

## Retry

After an interrupted answer, Retry adds a digest of the attempt to the
continuation message: its tool calls with the key argument and first result
line, the edited files, the todo plan and the end of its text. Claude resumes
its session at the last completed turn, so before this fix it did not see the
interrupted attempt's work at all.
