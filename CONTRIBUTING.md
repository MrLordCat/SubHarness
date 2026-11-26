# Contributing

Thanks for helping! This extension gives local models and subscription
providers (DeepSeek, Codex, Claude) their own SubHarness chat in VS Code. It is
Windows-first, tested on the current VS Code 1.143 and the minimum supported 1.131.

## Ground Rules

- One bug — one focused change. Do not touch unrelated areas.
- Every behavior change ships with a changelog entry (`CHANGELOG.md`).
- New logic requires tests. We practice red test first: add a failing test,
  then implement, then make the suite green.
- Versioning: dev patches increment the patch digit only (2.0.13, 2.0.14).
  Minor bumps (2.1.0) happen only on an explicit release command.

## Dev Setup

Windows with git-bash, Node 22+.

```bash
npm ci
npm run compile        # tsc -p ./
npm test               # full suite on the pinned VS Code 1.143.1 (vscode-test)
npm run lint
```

The test suite runs inside VS Code 1.143.1 pinned by `.vscode-test.mjs` as the
current stable test host. Check the minimum supported host with
`npm test -- --code-version 1.131.0`.

## Build & Install

```bash
npm run package        # builds llama-vscode-chat-{version}.vsix
code --install-extension llama-vscode-chat-{version}.vsix --force
```

Never copy extension folders into `~/.vscode/extensions/` by hand. Release
tagging, CI gates and publication are described in
[the development workflow](docs/DEVELOPMENT_WORKFLOW.md).

## Line Endings

`.gitattributes` uses `text=auto`, so Git stores LF blobs while a Windows
working copy checks out CRLF; `*.sh` is pinned to LF so its shebang works in
Git Bash and Linux. Files in the working tree are mostly CRLF. Keep each file's
existing line endings: check `file <path>` or the file bytes before a
multi-line edit.

## Areas

- `src/llama-provider.ts` — local + DeepSeek chat provider, request shaping,
  context budget, compaction, loop guards.
- `src/codex/`, `src/claude/` — subscription providers.
- `src/ui/` — Quick Access tree and the Providers Manager webview.
- `src/context/`, `src/memory/`, `src/tools/` — context budgeting/compaction,
  shared memory, tool-call reliability.

## Pull Requests

- Open a PR against `main` with a clear description and test evidence
  (`npm test` output).
- CI runs lint, the full test suite, and VSIX builds for Windows x64 and Linux
  x64.
- Do not bump the minor version in a PR.
