# SubHarness 2.0.7

The main agent now knows how to work with subagents in every project, not only
in repositories that describe it in their own instructions.

For the larger changes since 1.21.0 see the
[2.0.5 release notes](https://github.com/MrLordCat/SubHarness/releases/tag/v2.0.5);
2.0.6 added one model picker group per Codex account, see the
[2.0.6 release notes](https://github.com/MrLordCat/SubHarness/releases/tag/v2.0.6).

## Subagent guide in the system prompt

Whenever the subagent tool is offered, the chat's system prompt includes a short
guide for the main agent:

- plan the task, hand routine steps (edits in a few files, tests, code
  searches, checks) to the cheapest model that fits, and answer the user
  itself; keep architecture decisions, security-sensitive code and the final
  verification;
- do tiny steps itself when describing them would cost more than doing them;
- write self-contained subagent prompts: the goal, the files the subagent may
  change, the context it needs, the project rules, how to verify and what to
  report;
- review every report instead of taking it on trust, send fixes to the same
  subagent and close it once the work is accepted;
- when a model is unavailable, use one of similar size; premium or paid
  models only when you ask or nothing cheaper fits;
- agree on the plan with you before a large task.

Subagents do not get the guide. Repository instructions such as `AGENTS.md`
still take precedence where they say more. The guide is part of the stable
system prompt, so it is read from the prompt cache like the rest of it.

## Upgrade notes

- 2.0.5 and 2.0.6 offer 2.0.7 at their next update check; Quick Access →
  **SubHarness** → **Install Update** installs it right away.
- Versions before 2.0.5 cannot update automatically after the repository
  rename. Install 2.0.7 once by hand from
  https://github.com/MrLordCat/SubHarness/releases/latest, choosing
  `llama-vscode-chat-v2.0.7-win32-x64.vsix` or
  `llama-vscode-chat-v2.0.7-linux-x64.vsix`, then run **Developer: Reload
  Window**.
