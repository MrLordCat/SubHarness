# SubHarness 2.0.6

Two ChatGPT subscriptions side by side in the chat. With two or more Codex
accounts, every account lists its models in the chat's model picker, each in
its own group with its own limits.

For everything new since 1.21.0 (the SubHarness chat in the secondary side
bar, subagents, Keep/Undo, clickable file links and the repository rename),
see the [2.0.5 release notes](https://github.com/MrLordCat/SubHarness/releases/tag/v2.0.5).

## Upgrade notes

- 2.0.5 offers 2.0.6 at its next update check; Quick Access → **SubHarness**
  → **Install Update** installs it right away.
- Versions before 2.0.5 cannot update automatically after the repository
  rename. Install 2.0.6 once by hand from
  https://github.com/MrLordCat/SubHarness/releases/latest, choosing
  `llama-vscode-chat-v2.0.6-win32-x64.vsix` or
  `llama-vscode-chat-v2.0.6-linux-x64.vsix`, then run **Developer: Reload
  Window**.
- The setting `llamacpp.codexShowAllAccounts` is removed: every account's
  models are always listed. `llamacpp.codexActiveAccount` now only chooses the
  account that subagents, Quick Access and the Codex status commands use.
- Chats and model ids are unchanged; the built-in account keeps its
  `codex::` model ids.

## Several Codex accounts

- With two or more accounts, the model picker shows one group per account:
  **Codex 1** is the built-in `~/.codex` account, **Codex 2**, **Codex 3**…
  follow in the order of the account list. Model names inside a group carry no
  account suffix. With a single account the group stays **Codex**.
- Each group shows its own 5-hour and weekly limits and is dimmed on its own
  when its limit is used up, so you can switch to the other subscription.
- The quota chip under the input follows the selected model's account, and a
  limit card names the group whose limit was reached, for example "Codex 2
  usage limit reached".
- Each signed-out account gets its own entry in the picker, such as **Sign in
  to Codex 2**.
- Subagents keep using the models of the active account only.

Add an account from Quick Access → **Codex** → **ChatGPT Accounts** → **Add
Account…**; after the reload its sign-in page opens by itself.
