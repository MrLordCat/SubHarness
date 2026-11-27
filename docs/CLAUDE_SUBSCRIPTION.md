# Claude Subscription Provider

## Scope

The SubHarness chat offers supported Claude subscription profiles in its model
picker. Selecting one starts or resumes an official Claude Agent SDK `Query`.

Claude authentication, subscription limits, model execution, and persisted SDK
transcripts remain owned by the official Claude Code runtime. The extension
does not read Claude credential files.

## Runtime

Since 2.1.2 the Claude runtime (`claude`, `claude.exe` on Windows, about
100 MB to download and 330 MB on disk) is not part of the VSIX. It must match
the Agent SDK version exactly, so the extension downloads the platform package
`@anthropic-ai/claude-agent-sdk-<platform>` of that version from npm (sha512
checked, the binary must answer `--version`) into
`<globalStorage>/claude-runtime/<version>/`:

- a few seconds after startup, in the background, when the Claude provider is
  enabled, some Claude account is signed in and no runtime is found, so
  existing users get it right after an update without a prompt;
- before sign-in, after a confirmation;
- from `SubHarness: Install Claude Runtime` (Quick Access shows **Claude
  Runtime: Not installed** while it is missing).

The runtime is looked up in this order: `llamacpp.claudeCliPath`, the Anthropic
Claude Code extension's `resources/native-binary`, the platform package in
`node_modules` (development and tests), the downloaded runtime of the SDK's
version, and, while that one downloads after an update, the newest other
downloaded version. Older versions are removed after a new install unless a
running process still uses them. Without a runtime a Claude request fails at
once and names the install command.

## Sign-in

The Claude Code extension is not needed. `SubHarness: Sign In to Claude
Subscription` runs the runtime (see above) as `claude auth login --claudeai` in a terminal:
it opens the browser and may ask for a code. When the command ends or the
terminal closes, `claude auth status` gives the result. Only `loggedIn`,
`authMethod`, `subscriptionType` and `apiProvider` are kept; the email and
organisation are dropped. A method other than `claude.ai` means API billing and
gets a warning. A new sign-in may be another account, so open and durable
sessions are dropped.

`Sign Out of Claude` runs `claude auth logout`. Claude Code keeps one login
per config folder; for the built-in account (`~/.claude`) this also signs out
the Claude Code extension and the CLI.

## Several Accounts

`llamacpp.claudeAccounts` adds subscriptions beside the built-in one, each
with its own `CLAUDE_CONFIG_DIR` (default `~/.claude-<id>`). Every CLI process
of such an account — chat sessions, usage probes, `claude auth login`, `status`
and `logout` — runs with that variable, so the login, `.claude.json` and the
session files stay apart. The extension has one provider per account; the
built-in account keeps the `claude::<model>` ids and stored sessions, the others
use `claude::<id>::<model>` and state keys ending in `.account.<id>`. A session
of one account cannot resume under another, so a chat that moves to the other
subscription starts a new session from the chat history, as on a provider
switch. `llamacpp.claudeActiveAccount` names the account subagents try first
and Quick Access reports.

## Chat Tool Boundary

One `ClaudeAgentSession` owns a long-lived Agent SDK query and an asynchronous
user-message queue. Its runtime configuration is deliberately restrictive:

- built-in Claude Code tools are empty;
- setting sources, plugins, and skills are empty;
- `strictMcpConfig` is enabled;
- one SDK MCP server named `vscode` proxies the tools advertised by the current
  SubHarness chat request;
- `canUseTool` allows only `mcp__vscode__*` names and denies every other action.

The execution path is:

```text
SubHarness chat + selected Claude model
  -> ClaudeChatModelProvider
  -> persistent Claude Agent SDK Query
  -> mcp__vscode__* request
  -> LanguageModelToolCallPart
  -> SubHarness chat tool card, policy, and approval
  -> LanguageModelToolResultPart
  -> matching SDK MCP promise resolves
  -> the same Agent SDK Query continues
```

The extension therefore keeps Claude's reasoning/tool-selection loop native to
the Agent SDK while keeping executable actions visible and controlled by the
SubHarness chat. A tool step marked `completed` means that the matching VS Code tool result
returned to the SDK; Session Quality does not inspect or retain its body.

## Extended Context

The provider runs the platform-specific Agent SDK runtime and starts Opus 5
with the official `[1m]` model suffix. Claude follows
`llamacpp.sharedContextLength`, the working context shared with Codex, Coco and
Cursor, bounded to 258,400 through 967,000 tokens. It is not only VS Code
metadata: it is also passed to Claude Code as
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`. The upper bound leaves provider headroom
below the raw one-million-token model window. The former
`llamacpp.claudeContextLength` setting is deprecated and no longer read.

Open **Quick Access > Claude > Working Context** to use the shared Provider
Context slider. A changed value applies to a new SDK session; durable transcripts
remain eligible for restore. The cold-start serializer scales up to the chosen
target while retaining a provider/tool reserve. Live context details show both
the selected target and the raw limit returned by `getContextUsage()`.

## Session Reuse

Every logical turn records one of these modes:

| Mode | Meaning |
|---|---|
| `new` | No compatible in-memory or persisted SDK session matched; full input starts a new query. |
| `warm` | The existing in-memory query receives only the latest user turn. |
| `restored` | A validated persisted SDK session was found and resumed after process reload. |
| `resume-fallback` | Persisted resume failed before usable output; a fresh query retries with bounded full input. |

In-memory SDK sessions stay alive for 24 hours without user activity, and
armed rollover intents stay valid for 24 hours, so a pause or reload within a
day does not drop the live session.

Durable mappings contain session ids, hashes, SubHarness conversation identity,
turn index, conversation fingerprints, and timestamps in VS Code workspace
state. Claude message transcripts remain in the official Agent SDK session
store. The model, workspace, on-disk SDK transcript, and advancing conversation
must remain compatible before reuse. A changed current tool
catalog or reasoning profile does not by itself force a cold start: the Agent
SDK resumes with the current request's allowlisted tools and configuration.
Completed mappings remain eligible for seven days. Mappings written before
SubHarness chat turn indices were available migrate on the next advancing turn even if
the SubHarness chat compacted or rewrote the visible history during reload.

An unfinished JavaScript tool promise cannot survive Extension Host shutdown.
Reload at that boundary uses the validated fallback rather than pretending the
old tool call is still executable.

## Live Session Quality Metrics

Version 1.9.1 emits a stable request id when a logical Claude turn starts and
upserts that same Session Quality row until it reaches `completed`, `failed`,
`timed_out`, or `interrupted`. Native tool-result provider re-entry does not
create a second logical turn.

Agent SDK messages supply the following evidence:

- stream events: first model activity, first visible text, visible/thinking
  character progress, and running lifecycle;
- assistant `usage`: one model segment with fresh input,
  `cache_read_input_tokens`, `cache_creation_input_tokens`, output tokens, and
  `output_tokens_details.thinking_tokens`;
- result `usage`: authoritative aggregate input, cache read, cache creation,
  output, duration, and model-turn count;
- MCP delegation: ordered tool steps, names, status, and round-trip duration;
- `getContextUsage()`: raw provider limit, SDK usable limit, total tokens, and
  the SDK-provided context categories.

The cache percentage is `cache read / (fresh + cache read + cache creation)`.
Cache creation is shown separately: it is paid input that may become reusable
on a later model segment or turn, not an immediate cache hit.

The context snapshot arrives asynchronously after the terminal result and is
upserted into the same completed row. It is never copied from an older running
turn. Reports store counts, timings, tool names, lifecycle, request/session
identifiers, and context categories; they do not store prompts or tool-result
bodies.

### SubHarness context usage

After the visible text or native tool call on every completed provider response
boundary, the provider emits a `LanguageModelDataPart` with MIME type `usage`.
This includes each native-tool boundary and the terminal Agent SDK result, so
The SubHarness chat can update its context usage display throughout the turn.
The payload follows the OpenAI-compatible shape:

- `prompt_tokens` is fresh input plus cache-read and cache-creation input from
  the final assistant model segment;
- `prompt_tokens_details.cached_tokens` is that segment's cache-read input;
- `completion_tokens` is that segment's output;
- `total_tokens` is prompt plus completion tokens.

The final segment represents current context occupancy. The Agent SDK result's
aggregate counters can sum multiple model/tool steps and are therefore retained
for Live Report, usage history, and billing analysis instead of being sent as a
single native context value. The native denominator comes from the model's
advertised `maxInputTokens + maxOutputTokens`, capped by
the shared working context and refreshed when `getContextUsage()` reports a
different raw provider limit.

## Cancellation And Failure

- VS Code cancellation interrupts the active SDK query and finalizes the
  logical turn as interrupted.
- No completed response or no SDK activity for 90 seconds finalizes it as timed
  out and sends an SDK interrupt.
- API errors, stream termination, or session disposal finalize running model
  and tool steps with the corresponding terminal status.
- A queued tool call remains part of the same logical turn and is emitted on
  the next VS Code provider segment.

## Known Boundaries

- Tool availability still depends on the active SubHarness chat tool catalog,
  workspace trust and policy, installed extensions, and enabled connectors or
  MCP integrations.
- Subscription and context probes use Agent SDK control APIs whose exact fields
  can change with the installed official runtime; the provider validates and
  bounds the values it displays.
- Session Quality observes transport completion. It cannot independently judge
  whether a tool result was semantically useful to Claude.
- A real post-install smoke test is still required: select Claude, invoke at
  least one chat tool, let the final response complete, and confirm a
  single row with model/tool steps and a later context snapshot.