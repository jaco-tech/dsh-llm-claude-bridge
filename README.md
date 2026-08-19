# @jaco-tech/dsh-llm-claude-bridge

Claude Code subscription-backed model provider for DeepSeek Harness (`ctx.llm`).

Routes all LLM calls through your **Claude Code subscription** (the `claude` CLI / Claude Agent SDK) — allowing DSH to drive Opus/Sonnet/Haiku at **no extra per-token cost** — instead of using the pay-per-token Anthropic API.

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
        pathToClaudeCodeExecutable: '/home/jaco/.local/bin/claude'
```

## Known limitations

- **Tool results reach Claude Code only on the next turn.** DSH's agent loop is the
  real tool executor: the adapter emits `tool-call` chunks, finishes the step with
  `{kind: 'tool-calls'}`, and DSH runs the tool under its own sandbox and approval
  policy. The in-process MCP handler therefore returns a placeholder string
  immediately rather than blocking on the real result, so the Claude Code subprocess
  may emit a sentence or two of filler ("let me wait for the result…") before the
  step ends. The real result is picked up on the following turn, when the session is
  rebuilt from DSH's history. Correct output, some wasted tokens.
- **Verified paths.** Streaming (text + reasoning deltas), tool-call emission, and
  multi-turn session resumption are covered by `tests/`. A full
  call → result → follow-up turn round trip is not yet covered by an automated test.
- **Attachments.** Image blocks are passed through by attachment id and media type;
  binary payload wiring is untested.

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

In DSH, select any of the following models under the `claude-bridge` provider:

- `claude-bridge/claude-opus-5` (1M context)
- `claude-bridge/claude-opus-4-8` (1M context)
- `claude-bridge/claude-opus-4-7` (1M context)
- `claude-bridge/claude-opus-4-6` (1M context on Max plan)
- `claude-bridge/claude-sonnet-5` (1M context)
- `claude-bridge/claude-sonnet-4-6` (200k context)
- `claude-bridge/claude-sonnet-4-5` (200k context)
- `claude-bridge/claude-haiku-4-5` (200k context)
- `claude-bridge/claude-fable-5` (1M context)
