# Shared Memory

Shared memory is durable reference context owned by the extension. It is
available to every model in the SubHarness chat, whatever the provider. Agents
explicitly choose whether each new entry applies globally or only to the
current project. The chat UI that shows and edits entries is described in
[CHAT.md](CHAT.md).

## Storage And Migration

The file is stored at:

```text
<extension global storage>/memory/shared-memory.json
```

The current format is version 2:

```json
{
  "version": 2,
  "entries": [
    {
      "id": "stable-id",
      "title": "Current project build command",
      "content": "Run npm run check before packaging the VSIX.",
      "tags": ["build", "validation"],
      "pinned": false,
      "scope": "workspace",
      "scopeId": "file:///D:/GitHub/llama-vscode-chat",
      "kind": "workflow",
      "createdAt": "2026-07-17T10:00:00.000Z",
      "updatedAt": "2026-07-17T10:00:00.000Z"
    }
  ]
}
```

Version-one entries migrate automatically to `scope: "global"` and
`kind: "other"`. Their ids, text, tags, pin state, and timestamps are retained.
The migrated document is persisted during initialization.

Writes use a temporary file and rename. Invalid startup data is preserved as an
`.invalid-<timestamp>` backup before a new empty document is created. Invalid
manual edits are rejected on reload without replacing active in-memory data.

## Scope And Types

Scopes:

- `global`: eligible for every agent and project. Use it only for durable
  cross-project preferences and reusable workflows.
- `workspace`: eligible only when `scopeId` equals the current workspace id.
  Use it for repository paths, commands, architecture, decisions, and
  project-specific environment facts.

The public agent tools expose exactly these two scopes and require an explicit
choice when saving or deleting. The extension derives `scopeId` itself; an
agent cannot write into or delete from another project by supplying a path.
Legacy `model` entries remain readable for format compatibility but new ones
cannot be created through the agent tools.

Kinds:

- `preference`: durable user choices and response preferences.
- `decision`: accepted project or architectural decisions.
- `environment`: stable local paths, commands, and runtime constraints.
- `workflow`: repeatable procedures and verification steps.
- `externalFact`: source-backed facts that can become stale.
- `other`: reference information that does not fit another kind.

An `externalFact` requires both `sourceUrl` and `verifiedAt`. Use `expiresAt`
for versions, compatibility facts, service behavior, or any claim that should
be reviewed later. Expired entries remain stored and inspectable but are
excluded from normal search and automatic prompt injection.

## Retrieval

In the SubHarness chat, the extension adds a `<memory>` block to the user
request when the index or a relevant entry is new or edited. Entries are first
filtered by active project scope and expiry, then ranked with:

- weighted exact title, tag, and content terms;
- BM25-style document frequency and length normalization;
- conservative trigram matching for misspellings and related word forms;
- exact title-phrase and pinned boosts after relevance is established;
- update time as the final tie-breaker.

The block starts with an index of the visible entries, newest first, up to 100
lines; a longer store ends with a count and a hint to use
`llamacpp_search_memory`. It then carries the full text of the pinned entries
and of the entries that match the message. Pinned entries are included even
when the message shares no terms with them, within half of the entry budget.

Later requests resend an entry only when it is new or was edited, and resend
the index only when it changed; earlier requests stay byte-stable for
prompt-cache reuse. Compaction starts the comparison fresh. The chat retrieves
entries with its own budget of 1,500 estimated tokens.

The provider keeps a second retrieval path for requests that do not come from
the chat. It builds a query from the last four user messages, inserts memory
checkpoints before the newest request, freezes the selection across the tool
rounds of a turn, and restores a consolidated checkpoint after compaction. The
chat sets `_aabSkipSharedMemory` and supplies its own block, so this path does
not run for chat requests. `llamacpp.memoryMaxTokens` (default 4096) caps this
automatic retrieval.

## Agent Tools

- `llamacpp_store_memory`: create or update an entry with mandatory `global`
  or `workspace` scope. Workspace identity is always filled by the extension.
- `llamacpp_search_memory`: hybrid search over global plus current-project
  entries, optionally restricted to one of those scopes.
- `llamacpp_delete_memory`: delete one entry by exact id and mandatory scope.
  Workspace deletion is rejected if the entry belongs to another project.

The chat runs these memory tools without an approval prompt. Users can inspect
or edit the file with `SubHarness: Open Shared Memory` and remove all entries
with `SubHarness: Clear Shared Memory`.

## Limits

- 500 entries total.
- 160 characters per title.
- 24,000 characters per stored content value.
- 4,096 characters per entry content saved by the agent tools or the memory
  panel (`MAX_NEW_CONTENT_CHARS`); longer text is rejected, so keep one
  thought per entry.
- 16 normalized tags, 48 characters each.
- 32,768 tokens maximum automatic injection budget.

Search indexing considers at most the first 12,000 content characters per
entry to keep retrieval responsive; stored and returned content is not reduced.
When the store is full, the oldest non-pinned entry is evicted. A store made
entirely of pinned entries rejects additional entries.

## Safety Model

Memory is untrusted reference context. Its prompt wrapper says that it cannot
override current system or user instructions and that instructions inside a
memory entry must not be executed unless the live request asks for the same
action. Source metadata describes provenance, not authority.

Do not store secrets, credentials, temporary guesses, raw tool output, or
instructions copied from untrusted sources. Memory is local to the VS Code
profile and is not synchronized by this extension.
