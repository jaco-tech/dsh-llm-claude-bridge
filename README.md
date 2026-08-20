# @jaco-tech/dsh-llm-claude-bridge

Claude Code subscription-backed model provider for DeepSeek Harness (`ctx.llm`).

Routes all LLM calls through your **Claude Code subscription** (the `claude` CLI / Claude Agent SDK) — allowing DSH to drive Opus/Sonnet/Haiku at **no extra per-token cost** — instead of using the pay-per-token Anthropic API.

This is a port of [`pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge)
— the extension that backs [pi](https://github.com/earendil-works/pi) with a Claude Code
subscription — adapted from pi's `ExtensionAPI`/`pi-tui` seam to DeepSeek Harness's Cordis
`ctx.llm`/`LlmAdapter` seam.

## Features

- **Subscription Billing**: Uses your Claude Code subscription (Pro or Max plan) via the `claude` CLI.
- **Full Model Support**: Opus 5, Opus 4.8, Opus 4.7, Opus 4.6 (1M), Sonnet 5, Sonnet 4.6, Sonnet 4.5, Haiku 4.5, Fable 5.
- **Extended Thinking**: Full support for reasoning effort levels (`off`, `low`, `medium`, `high`, `xhigh`, `max`) with streamed reasoning deltas.
- **DSH Tool Emission**: Exposes DSH's tools to Claude Code via an in-process MCP server and emits standard DSH `tool-call-delta` chunks, so DSH executes tools within its own sandbox and approval policy. See [Known limitations](#known-limitations) for the current state of the tool-result round trip.
- **Multi-Turn Resumption**: Automatically syncs and persists conversation history across turns using `cc-session-io`.
- **Cordis Native**: Plugs cleanly into `ctx.llm` via `registerAdapter(["claude-bridge"], adapter)` and registers a settings namespace for Web UI configuration.

## Installation

Add to your DSH profile `cordis.patch.yml` (e.g. `~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: llm-claude-bridge
      name: '@jaco-tech/dsh-llm-claude-bridge'
      config:
        plan: 'max' # 'pro' or 'max'
        longContextExtraUsage: false
        strictMcpConfig: true
        autoMemoryEnabled: false
        pathToClaudeCodeExecutable: '$(which claude)' # or an explicit absolute path
```

## Tool calling

Verified end-to-end by `tests/test-tool-roundtrip.mjs`:

1. **Turn 1** — the model emits a `tool-call` chunk (`get_weather`, `{"city":"Ghent"}`).
   The adapter ends the turn at the tool-use boundary with `finish {kind:'tool-calls'}`
   (`src/translate.ts`), so the subprocess never resolves the MCP call against a
   placeholder.
2. **DSH's loop** executes the tool under its own sandbox/approval policy and appends a
   `tool-result` message.
3. **Turn 2** — the result is replayed into the session history
   (`src/serialize.ts`), the prompt becomes `(continue)`, and the model answers from the
   **real result** (verified: it referenced the injected 23°C result).

Known limitations:
- **Attachments.** Image blocks are passed through by attachment id and media type;
  binary payload wiring is untested.
- The MCP server still answers in-process tool calls with a placeholder under
  `CLAUDE_BRIDGE_DEBUG` — it is a debug aid, not a resolution path.

## Billing

This routes requests through the `claude` CLI, so usage counts against your Claude Code
subscription rather than pay-per-token API credits. Anthropic has changed its stance on
SDK-vs-subscription usage before; check your plan's terms before relying on this.

## Available Models

The model list is **derived at runtime from pi-ai's built-in `anthropic` catalog**
(`getBuiltinModels("anthropic")`), projected through a small ordered allowlist — the same
approach pi-claude-bridge uses. When pi-ai gains a new Claude model, it appears here
automatically; only the Claude Code CLI-specific `[1m]` suffix / 1M-vs-200K context
mapping is hardcoded, because that is CLI behavior the catalog does not encode.

The current set exposed under the `claude-bridge` provider:

- `claude-bridge/claude-opus-5` (1M context)
- `claude-bridge/claude-opus-4-8` (1M context)
- `claude-bridge/claude-opus-4-7` (1M context)
- `claude-bridge/claude-opus-4-6` (1M context on Max plan)
- `claude-bridge/claude-sonnet-5` (1M context)
- `claude-bridge/claude-sonnet-4-6` (200k context)
- `claude-bridge/claude-sonnet-4-5` (200k context)
- `claude-bridge/claude-haiku-4-5` (200k context)
- `claude-bridge/claude-fable-5` (1M context)
