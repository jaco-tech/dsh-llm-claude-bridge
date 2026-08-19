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

## Known limitations

**Tool results are not fed back into the Claude Code subprocess (yet).**

DSH's agent loop is what actually executes tools — it reads the `tool-call` chunk this
adapter emits, runs the tool under its own sandbox and approval policy, and the result
arrives in the next turn's message history. That part works.

What does *not* work yet is the inline path: the in-process MCP server hands Claude Code
a placeholder string (`(Tool <name> dispatched to DSH loop)`) instead of the real result,
so the CLI may keep generating text against a stub before the turn ends. The fix is to
block the MCP handler on the tool-call id until DSH reports the real result. Until then,
expect occasional filler text such as "waiting for the result to come back" at the end of
a tool-calling turn.

Verified working: streaming (text + reasoning deltas), tool-call emission with raw JSON
arguments, usage/finish ordering, and multi-turn session resumption. The tool-result round
trip is the untested path.

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
