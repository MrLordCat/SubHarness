# Snowflake Coco

Since 2.0.10, all adapters receive the SubHarness chat's own, already compacted
history; the common conversation journal is the full transcript prompts link
to. Codex, Coco and Cursor prepare handoffs using one token-budget planner. The old
million-character Coco cutoff is gone. See [shared context](SHARED_CONTEXT.md)
for settings, native continuation, archive/image preservation and long-run errors.

Requests with VS Code callback tools use native ACP even when SDK is selected:
the bundled CLI expires SDK callbacks after 30 seconds, including time spent
waiting for Chat approval and tool execution. In the measured case a 35-second
callback timed out on SDK while ACP returned its marker. ACP retains the native
session and supports longer tool waits. Text-only requests can still use SDK.

The backend rejects a fully qualified tool name longer than 64 characters,
counted after the `mcp__vscode_chat__` prefix. Aliases are bounded to that
limit and keep a stable hash suffix, so similar long names stay distinct. Names
are checked for length, characters and uniqueness before inference. Request
bounds and sanitized failures are recorded as `coco.request.prepared` /
`coco.request.failed` without prompt text.

Coco keeps a native session for each workspace, conversation, model and
Snowflake connection. Follow-ups append new entries, including entries from
another provider that continued the same Chat. Compatible completed sessions
resume after a VS Code reload through `session/load`; the history the server
replays is not shown as a new answer, and an interrupted or cancelled session
is not treated as a completed checkpoint. Rewinding/editing history creates a
fresh native branch; interrupted tool cycles are cancelled rather than reused.

A continuing session gets only the new entries plus the current environment
blocks. Since 1.21.35 the bridge also keeps a hash of the system instructions
(the system message without its environment blocks, for example the chat's
base rules and AGENTS.md). When they change, they go once more at the start of
the next entries, marked as replacing the earlier ones. Cursor sessions work
the same way. Sessions saved by an older version get them once.

Since 1.18.8, `llamacpp.cocoTransport=auto` uses the Snowflake `/code` SDK on
Node 22.22+ and ACP on older hosts. Explicit `sdk` and `acp` choices are available.
The CLI owns conversation history; the bridge preserves its native session ID.
Bindings are stored atomically on disk and mirrored in workspace state.
Failed load or preflight checks preserve the previous binding without silently
starting a fresh session. A confirmed native continuation can proceed even if
the optional handoff journal is unavailable.

A cold handoff uses one native prompt without hidden ACK imports. Since 1.18.11,
large handoffs are prepared locally: retain the complete latest request, prefer
user requirements and recent context, and put older tool output/images and
omitted text in an exact archive. Chat shows the reduction and archive path.
The model can read that archive through VS Code tools when a detail is missing;
an archive is not proof that every detail is in the active model context.
Historical @ references are quoted to avoid automatic attachment loading.
The target is the shared token budget from `prepareSharedHandoff`
(`sharedContextBudget` over the model window and tool schemas, capped by
`llamacpp.providerSwitchContextTokens` after a provider switch), not a fixed
character count; it is still an estimate, because SDK 0.0.2 exposes no exact
model tokenizer. A current request that alone exceeds the target is rejected
before inference. The CLI owns its actual finite window and subsequent native
compaction. There is no automatic multi-request replay after a failure.
A separate 64 MiB limit on encoded content
protects bridge memory/transport and includes JSON escaping, UTF-8 and image data.
Exceeding that safety limit archives the payload and stops before inference;
it is not a token count or model window. `llamacpp.cocoMaxHistoryImportParts`
is obsolete. Full transcripts, image bytes and oversized tool outputs remain
available locally for rereading.

Two further local limits are not model limits. The ACP client stops with an
explicit oversized-message error when its accumulated inbound buffer passes
4,000,000 characters. `convertCocoToolResult` cuts a tool result over 100,000
characters to a head/tail preview, while the full output stays in the archive
and transcript. Inside its finite window the Cortex CLI applies its own
summarization (`autoCompactThreshold`, 0.9 by default).

An interrupted native turn requires a new explicit user message. The bridge
resumes the stored session and skips the already-sent request. Repeated native
callback IDs reuse completed results visible in Chat. Missing acknowledgements
across process loss still require reconciliation; arbitrary new tool IDs are
not treated as proof that an earlier action did or did not execute.

Current Cortex ACP can emit `Error: internal error (request_id: ...)` and still
report `end_turn`. The bridge recognizes that exact error frame as a failed
request. Older checkpoints whose associated answer was this frame are rebuilt
from visible context on the next explicit user turn; original native histories
are preserved. It does not automatically replay an unsuccessful action.

The exact `claude-opus-5-5` ID starts with a verified 1,000,000-token window.
`llamacpp.cocoModelContextLengths` overrides per-model baselines; unknown models
use `llamacpp.cocoContextLength` (128,000 by default). Measured runtime windows
take precedence. A model's finite window and native compaction still apply.

Snowflake's own Coco panel runs `cortex acp serve` and uses `session/new`,
`session/load` and `_meta.clientTools`, so ACP is the native path, not a
workaround. `_meta.sessionId` and `session/list` are extensions of this runtime,
not portable ACP: the bridge never picks "the last session" by working
directory. `session/resume` and `session/fork` are not advertised; `session/load`
is the supported restore path. SDK 0.0.2 callbacks carry no native tool-use ID.

Workspace storage keeps session bindings, the conversation journal and archives;
the CLI keeps the native session text. The store keeps at most 32 saved sessions
and 8 warm sessions, and drops saved entries older than seven days. A checkpoint
for an unfinished request is not restored.

Install the Snowflake VS Code extension. SubHarness uses its bundled
`cortex` CLI through the Snowflake SDK and ACP. If your Snowflake CLI has
one connection, its name is selected automatically; otherwise set
`llamacpp.cocoConnection`. The `Auto (Coco)` entry is available immediately.
The models granted to your Snowflake role appear after an ACP connection
succeeds. Use **SubHarness: Refresh Models** to retry discovery.

The Snowflake extension's Azure sign-in session is passed to its own Coco panel
through a private API. SubHarness uses the CLI's Snowflake connection and
credential cache, so an Azure browser sign-in may be required once for the CLI.
No token is copied from the Snowflake extension. Coco delegates tools offered
for the turn, including private SubHarness chat tools, to the native Chat tool loop.
Chat controls approvals (including Allow All), execution cards and results.
The same ACP prompt stays alive while Chat executes each tool and returns its
result. Tool aliases distinguish these client tools from Cortex built-ins.
The Cortex CLI shows the model only the first 500 characters of a tool
description. The bridge sends each description with collapsed whitespace and,
when it is longer, cut at the last sentence end that fits. The bridge chat's
`subagent` tool also lists the model names in its `model` parameter, because
the list at the end of its description would be cut. Log entry
`coco.request.prepared` counts the cut descriptions (`cutToolDescriptions`).
The bridge stops built-in Cortex actions that attempt to bypass Chat, reporting
the problem in Chat instead of opening a separate permission picker.
Cortex's own system prompt asks Coco to sign commits and pull requests with
"Generated with [Snowflake CoCo](…)" and "Co-authored-by: Snowflake CoCo
<noreply@snowflake.com>". The bridge policy forbids that, and every tool call
Coco hands to Chat is cleaned before it runs: `-m`, `--message` and `--trailer`
arguments holding only that attribution are dropped, and lines holding only it
are removed from commands, messages and file contents. Text an edit must match
(`oldString`, `old_str`) is kept, so an earlier attribution can still be
removed from a file; text that only mentions Snowflake CoCo is left alone.
Use the Snowflake Coco panel for its own built-in SQL and other agent tools.
Commands run through the SubHarness chat's terminal tools in ordinary integrated terminals. Sequential commands
automatically reuse the last idle terminal, preserving its directory and shell
variables even when the model omits `terminalId`. Occupied or closed terminals
are skipped. Set `newTerminal: true` only when a separate shell is needed. If
`cwd` is specified, reuse requires that terminal's reported directory to match.
Open the terminal
panel to type input, press **Ctrl+C**, or close a terminal with its trash icon.
Chat still controls approval of the command. Native Agents `powershell`/`bash`
Background Shell tools are excluded from Coco's catalog. The companion tools
**cocoReadTerminal**, **cocoSendToTerminal**, and **cocoKillTerminal** read output,
send input, and close a terminal using the returned `terminalId`.
Finite commands use sync mode; a timeout leaves the command running and returns
its status. Servers can use async mode. Closing a terminal releases any pending
tool wait without automatically restarting the command. Shell integration must
be enabled with a supported default shell (PowerShell 7, bash or zsh). If it
cannot activate, the bridge reports the problem before sending the command.
After updating the extension, reload VS Code and start a new request so Coco
receives the updated tool catalog. Existing Background Shells remain separate.
The bridge sends text and image attachments. The picker enables vision after
ACP advertises image input. SDK 0.0.2 ignores image blocks on its stdin API,
so image turns use ACP with the same native session ID. Replay stays hidden;
images retain their original bytes and MIME types. The next text turn resumes
that same history through SDK. This capability choice happens before inference.

Images returned by a tool (`view_image`, a screenshot from a subagent, any tool
result with an `image/*` part) also reach Coco. The native client-tool protocol
cannot carry them: the Cortex CLI turns every client-tool result into text
(`registerClientTools` stringifies the JSON-RPC result). Only the CLI's own
built-in `read` puts an image inside a tool result. The bridge therefore saves
PNG, JPEG, GIF and WebP images (up to 4 MB) in its Coco archive and names the
file in the tool result; Coco opens it with `read` and sees it in the same turn.
That `read` is the single built-in action the bridge permits, only for files it
saved during the current turn, and only with the one-time `allow_once` option.
The `tool_call` event carries the path in `rawInput.file_path`; the permission
request carries it in its `read: <path>` title. A `read` of any other file that
asks for permission is refused with the one-time `reject_once` option: the CLI
tells Coco the read was denied and the turn continues. The CLI reads files
inside the workspace without asking; ending the turn afterwards would not undo
that read, so it is not stopped.

Other built-in actions (`write`, `edit`, `bash` and the like) are refused, not
stopped. The CLI announces such an action as a `pending` `tool_call` and asks
for permission with a `write: <path>` or `bash: <command>` title; the bridge
answers with the one-time `reject_once` option. Nothing runs, the CLI reports a
failed call to Coco and the turn continues, so its work and the Keep/Undo
changes stay. ACP carries only the chosen option, so the CLI tells the model
the user denied the action. The bridge corrects that: the next client-tool
result carries an `[SubHarness]` note saying the bridge refused the action
automatically and naming the client tools that replace it (file edits, file
creation, `run_in_terminal`). If Coco ends its turn without another client-tool
call, the note goes as a follow-up prompt in the same native session, at most
twice per turn. The turn still stops after eight refusals in one turn, for a
built-in action that runs without asking for permission, and for a pending one
that starts anyway. Diagnostics record `coco.tool.internal_refused` and
`coco.tool.internal_refusal_followup`.

If the image could not be saved or Coco does not read it, the bridge attaches
the bytes to a follow-up prompt
in the same native session, right after the current turn: up to four images, at
most 4 MB each and 8 MB together, deduplicated by SHA-256, at most eight times
per turn. When Coco called several image tools before ending its turn, the
newest images are sent. The attachment can only follow a finished native turn,
so the tool result and the policy tell Coco to end its turn at once with a
one-line note instead of continuing (or concluding that it cannot see images).
Binary parts that are neither text nor images stay a text note.

The model picker exposes **Thinking Effort** using the levels advertised by
Coco (currently Auto, Minimal, Low, Medium, High, and Max). The chosen value is
sent to the session before the prompt. Native thought deltas appear in the
thinking block, separately from the answer. A model or endpoint that does not
return thought deltas will only show its answer.

Coco also reports measured context usage to the native Chat indicator when ACP
sends `usage_update`. The current token count and total window come from the
runtime's `used` and `size` fields; the snapshot persists across tool-result
continuations and can decrease after compaction. Observed windows replace the
configured fallback for that model. The bridge does not treat cumulative billing
tokens as context or invent a measured count when the runtime sends none.

SDK/ACP prompt results also provide measured usage: uncached input, cache reads,
cache writes and output. Total input is
`inputTokens + cachedReadTokens + cachedWriteTokens`; cache hit is
`cachedReadTokens` divided by that total. These populate Coco's own Token Usage
category, Quick Access metrics and session diagnostics. Input totals include
cache reads and writes exactly once. SDK cumulative counters are differenced per
process; current context remains a separate snapshot. Cache availability depends
on the backend; a warm or restored session does not promise a hit. Missing
counters show as unreported.

`node scripts/coco-sdk-smoke.mjs --run --cli <cortex> --connection <name> --vision`
verifies a callback, warm continuation, process restart, image and subsequent
SDK continuation. It uses real model requests only with `--run`. On the verified
Opus 5.5 run, the marker survived all stages and the tool ran once. Warm input
was 82,664 tokens (82,596 cache reads); restored input was 82,924 (82,506 reads).
These are measurements of that test, not a cache-hit guarantee.

The opt-in test `live large handoff` in `coco-sdk.test.ts` uses
`AAB_COCO_LIVE_ARCHIVE` and optionally `AAB_COCO_LIVE_CLI`. It sends two real
diagnostic prompts with no callable project tools. On 2026-10-19, the reported
3,045,868-character archive was prepared and both control facts survived the
first prompt and native restart (34 seconds total). Normal tests skip it.

Quick Access has a **Coco** section with live ACP connection status, the
discovered model count, an on/off source toggle, Snowflake connection selection,
catalog refresh, and links to the native thinking picker, Coco settings, and the
Snowflake Coco panel. Status checks open an ACP session without running inference.
Each check starts its own Cortex CLI process, and with Snowflake 1.44.0 each
process may open a browser sign-in (a CLI token-cache issue). Since 1.21.32
the last result (models, thinking levels, status) is saved per CLI path and
connection and survives window reloads. An automatic check runs only for a CLI
or connection with no saved result; after that, only a Coco turn or a manual
check talks to the CLI. A failed check is not retried by itself. A manual check
waits up to 180 seconds and shows "Waiting for Snowflake sign-in" after 10
seconds; a successful check lets the CLI exit on its own (5 seconds) before
stopping it. A live chat session keeps its CLI for 30 minutes after a turn.
An exited CLI is replaced on the next turn and its native session reloads. Since 1.18.10, manual
**Connection Status** and **Refresh Models** force one shared check, preserving
the catalog and thinking levels while it runs. Selecting the existing
**Snowflake Connection** also retries it without rewriting settings; cancelling
the picker does nothing. The notification shows
the current stage and supports **Cancel**. Startup and model discovery together
have a 45-second deadline; a timeout or cancellation stops the owned CLI and
reports an actionable status. Repeated refresh clicks share the same operation
instead of restarting it or adding more notifications.
**Open Snowflake Coco** selects Snowflake's secondary-sidebar view on current
VS Code, falling back to the classic view when needed. It shows cancellable
activation progress with a 45-second deadline and reports failures. Cancelling
or timing out prevents a late panel opening from that attempt. Credentials are
managed by Snowflake/CLI: a valid cached login does not require a new sign-in.
The section stays visible when Coco is offline so reconnect and setup controls
remain available.