# Architecture

## Scope

The SubHarness chat exposes OpenAI-compatible local models, DeepSeek, Cursor,
Codex, Claude and Snowflake Coco through independent transports and lifecycles.
Stable compatibility ids remain under the `llamacpp` namespace.

## Runtime Components

- `src/extension.ts` is the composition root. It creates services and registers
  the provider, commands, status items, UI providers, and chat services; memory
  tools are chat tool definitions (`src/memory/tools.ts`) in the chat catalog.
- `src/composite-provider.ts` consumes `ProviderRegistry` to combine catalogs
  and route each model to its registered owner, isolating discovery failures.
- `src/providers/model-descriptor.ts` projects shared model metadata to VS Code;
  `provider-snapshot.ts` keeps source metrics and distinct usage kinds.
- `src/providers/api-source-router.ts` dispatches API-profile transports,
  including Cursor SDK, while preserving profile identity and credentials.
- `src/providers/async-resource-cache.ts` owns shared loads, TTL and generation
  invalidation for catalogs and balances, with independent reader cancellation.
- `src/llama-provider.ts` coordinates model discovery, request attempts,
  compatibility retries, streaming, and metrics.
- `src/base-provider.ts` owns OpenAI-compatible token estimation and SSE
  streaming/tool-call parsing.
- `src/utils.ts` converts VS Code messages and tools to OpenAI-compatible
  payloads and validates tool-call history.
- `src/logger.ts` writes structured JSONL diagnostics without message bodies or
  authorization headers.
- `src/codex/` owns ChatGPT subscription discovery, `codex app-server` JSONL,
  thread reuse, dynamic VS Code tools, the fail-closed native tool bridge, and
  exact rollout/live model-segment metrics.
- `src/claude/` owns Claude Code discovery, persistent Agent SDK queries,
  subscription limits, warm conversation reuse, a VS Code-only MCP allowlist,
  and live logical-turn usage/context/tool metrics.
- `src/cursor/` owns saved-profile discovery, persistent SDK sessions, native
  token/cache metrics, lossless handoffs, callback tools and the chat-only HTTP
  fallback. `src/coco/` owns Snowflake ACP sessions and tools.
- `src/providers/conversation-history.ts` journals visible Chat messages for
  Coco/Cursor handoffs; `conversation-anchors.ts` shares stable user anchors.
- `src/tools/delegated-turn-state.ts` shares response boundaries and bounded
  buffers for Cursor/Coco and pending-result delivery across all SDK adapters.
- `src/provider-metrics.ts`, `src/token-usage-history.ts`, and
  `src/usage-experiment.ts` normalize provider telemetry and persist bounded
  comparison data without prompt bodies.
- `src/subagent-guidance.ts` adds stable provider/model routing guidance to the
  SubHarness chat subagent tool without changing its execution boundary.
- `src/memory/` owns durable shared memory, retrieval, prompt injection, and
  the chat's memory tool definitions in `tools.ts`.
- `src/tools/tool-call-reliability.ts` owns deterministic tool argument repair,
  schema validation, metrics, and repeated identical-call detection.
- `src/diagnostics/` owns provider health reports and session-quality
  aggregation. Running turns are upserted by request id so provider re-entry
  after a native tool result does not create duplicate logical turns.
- `src/context/context-budget.ts` owns pure soft/hard input budgets and context
  usage estimates shared by initial requests and overflow retries.
- `src/context/output-budget.ts` separates normal per-source output defaults
  from explicit request limits and the global hard ceiling.
- `src/context/message-compaction.ts` owns deterministic non-mutating history
  compaction with bounded structured summaries of old tool activity.
- `src/context/server-token-counter.ts` owns llama.cpp chat-template application,
  exact tokenization, short-lived count caching, and unsupported-server fallback.
- `src/context/system-prompt.ts` owns the stable knowledge-verification policy,
  custom system instructions, and non-mutating prompt-prefix injection.
- `src/context/tool-result-summary.ts` extracts bounded, non-secret structural
  facts shared by live tool-result truncation and history compaction.
- `src/context/usage.ts` validates upstream token counters and builds the
  fallback statistics forwarded to the SubHarness chat's session information.
- `src/reasoning.ts` maps VS Code session effort values to local and DeepSeek
  request profiles and supplies the native model configuration schema.
- `src/request/chat-request.ts` builds source-specific OpenAI-compatible request
  bodies without transport or VS Code dependencies.
- `src/model-sources/source-routing.ts` owns source ids, URL deduplication,
  source construction, and model-family routing.
- `src/transport/openai-http.ts` owns endpoint resolution, timeouts,
  cancellation, and serialized HTTP requests.
- `src/transport/request-queue.ts` owns serial request admission, FIFO waiting,
  cancellation, queue timeouts, and idempotent slot release.
- `src/ui/quick-access.ts` composes Quick Access sections from a captured provider
  snapshot. `quick-access-items.ts` owns tree identity and shared metric rows;
  balance requests refresh independently in the background.
- `src/ui/session-quality-panel.ts` owns the live, state-preserving diagnostics
  webview with filters, issue highlighting, expandable turn details, usage
  segments, and Codex model/tool step timelines.
- `src/ui/model-behavior-commands.ts` owns reasoning and tool-mode pickers and
  command handlers.
- `src/constants.ts` contains shared product, provider, endpoint, and limit
  constants.

`src/vscode.d.ts` is a checked-in VS Code API declaration used for the language
model provider surface. Update it explicitly with `npm run update-vscode-api`.

## Chat runtime

The SubHarness chat in the secondary side bar is the only agent surface; it is
not a VS Code chat participant and contributes no language-model tools to the
host.

- `src/chat/agent-loop.ts` runs one agent turn: it sends the conversation to
  the selected provider, executes returned tool calls through the chat catalog,
  feeds the results back, and ends when the model answers without a tool call
  or the user stops.
- `src/chat/chat-controller.ts` owns sessions, approvals, subagents, Keep/Undo
  change sets, queued messages and auto-continue after a subscription limit
  resets.
- `src/chat/tools/` defines the built-in catalog: files, search, terminals,
  `run_checks`, `changes_diff`, `subagent`, `ask_questions`, todo and tool
  access. Memory tools come from `src/memory/tools.ts`; extension and MCP tools
  are added from the VS Code catalog.
- `src/chat/context-cleaning.ts` stubs stale tool results before a new request;
  `src/chat/compaction.ts` summarizes long chats and model handoffs.
- `src/chat/subagent-runner.ts` runs a subagent's own tool loop and report.
- `src/chat/changes/` records Keep/Undo snapshots in shadow git repositories.
- `src/chat/webview/` is the chat UI.

See [the chat guide](CHAT.md) for user-visible behaviour and approvals.

## Provider contracts

`ProviderRegistry` owns model ownership, catalog aggregation and change
propagation. A registration pairs a `ProviderSourceDefinition` (stable id,
label, status mode, enabled setting) with a VS Code provider and an ownership
predicate; composite routing, the directory and model grouping consume these
registrations. Quick Access renders a generic `ProviderSnapshot`; integrations
can add extra controls. API-profile transports use `ApiSourceAdapter` through
`ApiSourceRouter`; HTTP request policies remain inside the HTTP implementation,
and the Cursor SDK uses its own adapter.

Model adapters supply a `ModelDescriptor` (native id, capabilities, context
origin and output policy) to `modelInformation`. Reasoning values and wire
parameter names stay protocol-specific. A working cap cannot increase a
model's reported window.

Use source ids for runtime metrics. Family names describe model behavior and
must not determine the account billed for a request. Persisted usage history
keeps its existing categories and adds a separate API category. `spendingCap`,
`monthlyUsage`, `creditsBalance` and `rollingQuota` have different meanings;
format their typed values without treating them as interchangeable.

Catalog and balance loads share `AsyncResourceCache` (TTL, one in-flight load
per key, invalidation generations and independent reader cancellation).
Invalidation retires the old entry before aborting its loader, so a late
response cannot publish into a newer entry. Cancelling one reader detaches only
that reader; source refresh or disposal owns shared cancellation. Catalog cache
identities include a credentials revision or a private digest, never the secret
itself.

Cursor and Coco use the shared response boundary and output buffer in
`DelegatedTurnState`. Claude and Codex use `PendingToolRegistry` for
exactly-once delivery and settlement of native tool callbacks while retaining
their long-lived runtime and recovery. Protocol adapters own result
serialization, batch timing, timeout policy, usage events and delivery of
steered messages. All delegated actions continue to execute through the
SubHarness chat tools.

Contract suites cover registry extension, metadata and source attribution,
cache generations and cancellation, transport dispatch and delegated results.
Protocol suites verify native tool calls, images and session recovery.

See [the development workflow](DEVELOPMENT_WORKFLOW.md) for verification and
releases.

## Request Flow

1. VS Code asks the composite provider for available models.
2. Local/DeepSeek discovery, Codex app-server discovery, and Claude Agent SDK
  discovery run independently; fulfilled catalogs are merged and sorted.
3. For a chat turn, the source-prefixed model id selects exactly one provider.
  Local and DeepSeek requests follow the OpenAI-compatible flow below; Codex
  and Claude retain their own warm runtime state. Completed subscription
  sessions can be restored from provider-owned durable transcripts after an
  Extension Host restart.
4. A session-scoped native reasoning selection overrides the global mode when
   the SubHarness chat supplies it through request options.
5. VS Code messages and tools are converted to OpenAI format.
6. The stable provider knowledge policy is prepended to native system instructions.
7. Relevant non-expired memory for the active workspace/model scope is inserted
   immediately before the latest user turn, preserving the stable cached prefix.
8. Tool results are sanitized/summarized and the complete local prompt is
   counted with the active server template and tokenizer when available.
9. The serial transport queue grants the request slot.
10. The pure request builder applies local or DeepSeek fields, then the request
   is sent to the source-specific chat completion endpoint.
11. SSE chunks are coalesced; tool calls are repaired conservatively and
   validated against the advertised schema before they are emitted to VS Code.
12. A rejected tool call can trigger one bounded correction request when no
   visible output or executable tool call has escaped the failed stream.
13. The final upstream usage chunk is validated and emitted as native `usage`
   response data, with an estimate used only when the server omits it.
14. Transient transport failures can retry only before streaming starts;
   context overflow, tool-role incompatibility, or empty output use separate
   bounded recovery paths.

### Codex subscription flow

1. The user selects a discovered `codex::` model and reasoning effort in the
  SubHarness chat's model picker.
2. A strict app-server thread starts in read-only mode with built-in shell,
  file, web, MCP, browser, plugin, hook, image, and subagent actions disabled.
  Codex's permissions message is left out, so the model does not read the
  sandbox as a ban on edits through the dynamic tools.
3. The current SubHarness chat tool catalog is canonicalized and advertised as
  app-server dynamic tools. Core coding tools stay eager; uncommon schemas can
  be loaded through the app-server tool-search mechanism.
4. Tool calls are emitted as native VS Code cards and the app-server turn is
  suspended until their results return. VS Code may re-enter the provider with
  a tool result, but the same app-server turn resumes instead of starting a new
  model request or serializing a continuation prompt.
5. Calls arriving after a delegated boundary are queued and exposed in the
  next native segment; only already visible calls require results on resume.
6. Completed compatible threads reuse an exact conversation anchor and send
  only incremental input. Non-ephemeral thread ids and validation fingerprints
  are stored in workspace state, reattached with `thread/resume` after reload,
  and fall back to a new full-history thread when reattachment fails.
7. App-server token notifications and persisted rollout data feed one running
  Session Quality record. Model usage segments and tool-step state update live;
  final rollout metrics replace the fallback snapshot when available.

### Claude subscription flow

1. The official Agent SDK starts with built-in tools, plugins, skills, and
  external MCP configuration disabled.
2. SubHarness chat tools are hosted by one SDK MCP server; `canUseTool` allows only its
  `mcp__vscode__*` names.
3. Matching conversations reuse warm sessions. Native tool results resume the
  suspended SDK query rather than constructing a second request history.
4. Completed sessions use the Agent SDK transcript store. A stable SubHarness chat
  conversation id, model/runtime fingerprint, and user-history prefix select a
  resumable session after reload; an invalid resume safely retries from full
  VS Code history before visible output is emitted.
5. Subscription and model-context probes refresh periodically; probes for
  Claude availability never block Local, DeepSeek, or Codex requests.
6. One stable logical-turn id spans assistant model segments and all native
  tool-result provider re-entry. Stream events, assistant usage, aggregate
  result usage, MCP tool duration, terminal status, and `getContextUsage()`
  snapshots upsert the same Session Quality record.
7. Anthropic fresh input, cache read, and cache creation remain distinct. The
  report does not misclassify cache creation as either a hit or ordinary fresh
  input, and it retains thinking tokens per assistant model segment.

### Reload and tool-catalog stability

Closing VS Code necessarily restarts the SubHarness chat, Extension Host processes,
and subscription-provider subprocesses. The extension cannot skip VS Code's
physical tool registration, but it prevents that registration from becoming a
semantic cold start:

- the SubHarness chat forwards a stable conversation identity;
- Local and DeepSeek canonicalize tool order and JSON Schema keys so the exact
  server-side prompt-cache prefix survives a reload;
- Codex canonicalizes dynamic tools and reattaches a durable app-server thread;
- Claude canonicalizes its MCP tool catalog and resumes a persisted SDK session.

Changing the model, workspace, reasoning effort, or effective tool schema still
invalidates the relevant session intentionally. Reload during an unfinished
native tool call also uses the full-history fallback because JavaScript promise
state cannot survive process termination.

## Persistent Data

- API keys: VS Code `SecretStorage`.
- Shared memory: `<globalStorage>/memory/shared-memory.json`.
- Diagnostics: `<globalStorage>/logs/*.jsonl`.
- Generated reports: `<globalStorage>/reports/*.{md,json}`.
- Token usage and comparison experiments: bounded JSON under `<globalStorage>`.
- Provider resume mappings: bounded ids, hashes, and history anchors in VS Code
  workspace state. Claude message transcripts remain in the official Agent SDK
  session store; Codex transcripts remain in the Codex app-server store.
- User configuration: `llamacpp.*` VS Code settings.

DeepSeek has a dedicated `llamacpp.deepSeekApiKey` secret. The generic primary
server key remains `llamacpp.apiKey`; a legacy fallback keeps older installs
working.

## Invariants

- Source prefixes are never sent as model ids to upstream servers.
- Model-source catalogs are not cached across secret, `llamacpp.*` setting or
  API-profile changes: a stale cache could send an API key to the previous
  address.
- Codex and Claude cannot execute actions outside the SubHarness chat's tool
  cards.
- A selected Codex model uses the contributed model-provider path; no secondary
  participant or hidden execution surface may be introduced for the same flow.
- A detached Codex bridge may queue only calls belonging to an already pending
  native tool turn; an unrelated detached call is rejected and logged.
- DeepSeek-only fields and llama.cpp-only fields stay source-specific.
- Cancelling a turn cancels the streaming response body, so an abandoned
  generation does not hold the local server slot.
- Network failures and HTTP 429/502/503/504 retry with cancellation-aware
  exponential backoff before the stream starts; timeouts and other client
  errors do not.
- Memory and tool schemas count against the same request budget as messages.
- Exact server counts include the active chat template and tool catalog; the
  heuristic remains mandatory for OpenAI-compatible servers without tokenizer
  endpoints.
- Memory content is reference data and cannot override current system/user
  instructions.
- Externally verified memory requires source provenance and verification time;
  expired memory is excluded from automatic retrieval.
- Tool calls are never repaired by inventing values or changing argument types.
- Compaction is lossy but keeps complete tool turns and code/decision
  milestones.
- Knowledge policy and custom durable instructions stay before mutable history;
  source-aware tool descriptions remain stable across turns for cache reuse.
- Logs may contain counts, timings, model ids, and tool names, but not API keys
  or raw message bodies.
- Changes to conversion, compaction, streaming, routing, or memory require tests.

## Remaining Boundaries

The OpenAI-compatible provider intentionally remains the largest lifecycle
coordinator because streaming retries share turn-local state. Codex and Claude
are isolated behind their runtime clients. Further extraction should be driven
by a smaller stable interface or measured contention, not line count alone.
