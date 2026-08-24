// Per-session long-lived Claude Code query.
//
// One Claude Code subprocess per DSH session, kept alive across turns. Tool
// calls park the in-process MCP handler instead of ending the query, so the
// subprocess's own session file accumulates the real transcript — prompts,
// tool_use, genuine tool results — and the model continues its task on the
// next turn instead of resuming an interrupted transcript and answering with
// the "no prior work ... interrupted" stub.
//
// Architecture (mirrors pi-claude-bridge's provider path):
//   - `prompt: AsyncIterable<SDKUserMessage>` — a parked PromptStream fed per
//     turn.
//   - A single background consumer iterates the SDK query and routes events
//     to the currently-active TurnPump.
//   - On `message_stop` after any `tool_use` block, the consumer marks the
//     turn finished (kind: tool-calls) and parks it. The MCP handler for each
//     call blocks on a pending promise. (A single assistant message can carry
//     MULTIPLE tool_use blocks — ending the turn at the first block's
//     content_block_stop drops the rest, and their MCP handlers park forever:
//     Claude Code dies with error_during_execution and stop_reason=tool_use.)
//   - The next stream() call resolves pending handlers from the tool-result
//     blocks in the incoming history (real results, executed by DSH), which
//     unblocks the subprocess; the consumer then routes the continuation to
//     the new turn's pump.
//
// Failure containment: any subprocess death or SDK error fails every parked
// turn and every pending MCP handler, and drops the session so the next
// stream() call cold-starts a fresh query.

import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlock, StreamChunk } from "@deepseek-ai/dsh-llm";
import { CallId as makeCallId } from "@deepseek-ai/dsh-llm";
import type { Config } from "./config.js";
import { createMcpToolServer, type BridgeToolDef } from "./mcp-server.js";
import { makePromptStream, type PromptStream } from "./prompt-stream.js";
import { normalizeToolName } from "./translate.js";

const CC_CHILD_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
} as const;

interface PendingToolCall {
  /** DSH-side call id (sanitized CC tool_use id). */
  callId: string;
  name: string;
  resolve: (result: { content: string; isError?: boolean }) => void;
  reject: (error: Error) => void;
}

/**
 * One turn's chunk sink. The background consumer pushes translated chunks;
 * the per-turn async generator in the adapter drains them.
 */
class TurnPump {
  private chunks: StreamChunk[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private failure: Error | null = null;

  push(chunk: StreamChunk): void {
    if (this.done) return;
    this.chunks.push(chunk);
    this.kick();
  }

  finish(): void {
    this.done = true;
    this.kick();
  }

  fail(error: Error): void {
    this.failure = error;
    this.done = true;
    this.kick();
  }

  get isDone(): boolean {
    return this.done && this.chunks.length === 0;
  }

  private kick(): void {
    this.wake?.();
    this.wake = null;
  }

  async *drain(): AsyncGenerator<StreamChunk> {
    while (true) {
      while (this.chunks.length === 0 && !this.done) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
      if (this.chunks.length > 0) {
        yield this.chunks.shift()!;
        continue;
      }
      if (this.failure) throw this.failure;
      return;
    }
  }
}

interface LiveSession {
  promptStream: PromptStream;
  sdkQuery: Query;
  pendingToolCalls: Map<string, PendingToolCall>;
  /**
   * Results DSH delivered before the CLI invoked the matching MCP handler.
   * Claude Code invokes MCP tools SEQUENTIALLY even for parallel tool_use
   * blocks: handler N+1 only fires after handler N resolves. DSH delivers
   * all results at once on the next stream() call, so results for later
   * calls arrive here first and must be queued, not dropped.
   */
  queuedToolResults: Map<string, { content: string; isError?: boolean }>;
  currentTurn: TurnPump | null;
  capturedSessionId: string | null;
  /** Settled when the background consumer exits (death or close). */
  dead: Error | null;
  cliModelId: string;
  cwd: string;
}

export class LiveSessionManager {
  private sessions = new Map<string, LiveSession>();

  constructor(private configSource: () => Config) {}

  has(dshSessionId: string): boolean {
    return this.sessions.has(dshSessionId);
  }

  /**
   * Ensure a live session exists for `dshSessionId`, creating the Claude Code
   * subprocess on first use. Returns the session and whether it was created.
   */
  ensure(
    dshSessionId: string,
    options: {
      cliModelId: string;
      cwd: string;
      system?: string;
      reasoningEffort?: string;
      tools: BridgeToolDef[];
    },
  ): LiveSession {
    const existing = this.sessions.get(dshSessionId);
    if (existing && !existing.dead) return existing;
    if (existing) this.sessions.delete(dshSessionId);

    const config = this.configSource();
    const promptStream = makePromptStream();
    const pendingToolCalls = new Map<string, PendingToolCall>();

    const session: LiveSession = {
      promptStream,
      sdkQuery: null as unknown as Query,
      pendingToolCalls,
      queuedToolResults: new Map(),
      currentTurn: null,
      capturedSessionId: null,
      dead: null,
      cliModelId: options.cliModelId,
      cwd: options.cwd,
    };

    // MCP handlers block until the next stream() call delivers DSH's real
    // tool result — that is what keeps the subprocess's transcript genuine.
    // Registration and delivery are symmetric: if DSH's result already
    // arrived (queuedToolResults — Claude Code invokes handlers sequentially,
    // so later parallel calls register after delivery), resolve immediately.
    const mcpTools: BridgeToolDef[] = options.tools.map((t) => ({
      ...t,
      handler: (toolCallId, args) =>
        new Promise((resolve, reject) => {
          const queued = session.queuedToolResults.get(toolCallId);
          if (queued) {
            session.queuedToolResults.delete(toolCallId);
            resolve({ toolCallId, content: queued.content, isError: queued.isError });
            return;
          }
          pendingToolCalls.set(toolCallId, {
            callId: toolCallId,
            name: t.name,
            resolve: (r) =>
              resolve({ toolCallId, content: r.content, isError: r.isError }),
            reject,
          });
        }),
    }));

    const mcpServers =
      mcpTools.length > 0
        ? { "dsh-tools": createMcpToolServer("dsh-tools", mcpTools) }
        : undefined;

    let effort: string | undefined;
    if (options.reasoningEffort && options.reasoningEffort !== "off") {
      effort = options.reasoningEffort;
    }

    const extraArgs: Record<string, string | null> = { model: options.cliModelId };
    if (config.strictMcpConfig) {
      extraArgs["strict-mcp-config"] = null;
    }
    if (effort) {
      extraArgs["thinking-display"] = "summarized";
    }

    const sdkQuery = query({
      prompt: promptStream.stream,
      options: {
        cwd: options.cwd,
        env: { ...process.env, ...CC_CHILD_ENV },
        tools: [],
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
        settings: { autoMemoryEnabled: config.autoMemoryEnabled },
        systemPrompt: options.system
          ? { type: "preset", preset: "claude_code", append: options.system }
          : { type: "preset", preset: "claude_code" },
        extraArgs,
        ...(effort ? { effort: effort as never } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        ...(config.pathToClaudeCodeExecutable
          ? { pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable }
          : {}),
      },
    });

    session.sdkQuery = sdkQuery;
    this.sessions.set(dshSessionId, session);

    // Background consumer: translate SDK events into StreamChunks for the
    // active turn. Lives for the whole subprocess lifetime.
    void this.consume(dshSessionId, session, sdkQuery);

    return session;
  }

  /** Push the turn's user message(s) into the live subprocess. */
  async pushUserMessage(
    session: LiveSession,
    text: string,
    sessionIdForMessage: string,
  ): Promise<void> {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionIdForMessage,
    } as SDKUserMessage;
    await session.promptStream.push(msg);
  }

  /** Resolve parked MCP tool calls with DSH's real results. */
  deliverToolResults(
    session: LiveSession,
    results: Array<{ callId: string; text: string; isError?: boolean }>,
  ): string[] {
    const unmatched: string[] = [];
    for (const r of results) {
      const pending = session.pendingToolCalls.get(r.callId);
      if (pending) {
        session.pendingToolCalls.delete(r.callId);
        pending.resolve({ content: r.text, isError: r.isError });
        continue;
      }
      if (session.queuedToolResults.has(r.callId)) {
        // Duplicate delivery of an already-queued result — unexpected.
        unmatched.push(r.callId);
        continue;
      }
      // Handler not invoked yet (sequential MCP invocation for parallel
      // tool_use blocks) — queue the result so the handler resolves the
      // moment it registers.
      session.queuedToolResults.set(r.callId, { content: r.text, isError: r.isError });
    }
    return unmatched;
  }

  /** Arm a fresh turn pump and return its chunk stream. */
  beginTurn(session: LiveSession): AsyncGenerator<StreamChunk> {
    const pump = new TurnPump();
    session.currentTurn = pump;
    return pump.drain();
  }

  /** Tear down every live session's subprocess (plugin disposal/tests). */
  async destroyAll(): Promise<void> {
    for (const key of [...this.sessions.keys()]) {
      await this.destroy(key);
    }
  }

  /** Tear down the subprocess and fail everything parked. */
  async destroy(dshSessionId: string): Promise<void> {
    const session = this.sessions.get(dshSessionId);
    if (!session) return;
    this.sessions.delete(dshSessionId);
    const err = new Error("claude-bridge session destroyed");
    for (const p of session.pendingToolCalls.values()) p.reject(err);
    session.pendingToolCalls.clear();
    session.currentTurn?.fail(err);
    session.promptStream.end();
    try {
      session.sdkQuery.close();
    } catch {}
  }

  private async consume(
    dshSessionId: string,
    session: LiveSession,
    sdkQuery: Query,
  ): Promise<void> {
    const debug = (msg: string) => {
      if (!process.env.CLAUDE_BRIDGE_DEBUG) return;
      const line = `[cb-debug] live dsh=${dshSessionId} ${msg}`;
      console.error(line);
      import("node:fs")
        .then((fs) => fs.appendFileSync("/tmp/cb-debug.log", line + "\n"))
        .catch(() => {});
    };

    // Per-assistant-message translation state (reset each message_start).
    let nextBlockIndex = 0;
    // Set when the current assistant message contains at least one tool_use
    // block. The turn ends at that message's message_stop — NEVER at a single
    // tool-call's content_block_stop — so multi-tool_use messages (parallel
    // tool calls) are collected whole. Mirrors pi-claude-bridge's
    // turnSawToolCall + message_stop handler (src/index.ts).
    let turnSawToolCall = false;
    const activeBlocks = new Map<
      number,
      {
        index: number;
        type: "text" | "reasoning" | "tool-call";
        text: string;
        toolCallId?: string;
        toolName?: string;
        partialJson?: string;
      }
    >();
    let tokenUsage = { inputTokens: 0, outputTokens: 0 } as {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };

    try {
      for await (const message of sdkQuery) {
        if (!session.capturedSessionId && (message as { session_id?: string }).session_id) {
          session.capturedSessionId = (message as { session_id?: string }).session_id!;
          debug(`captured claude session ${session.capturedSessionId}`);
        }

        const turn = session.currentTurn;
        const event = (message as { event?: Record<string, unknown> }).event;

        if (!event) {
          if (message.type === "result") {
            const res = message as unknown as {
              subtype?: string;
              usage?: Record<string, number>;
              result?: string;
            };
            if (res.usage) {
              tokenUsage = {
                inputTokens: res.usage.input_tokens ?? tokenUsage.inputTokens,
                outputTokens: res.usage.output_tokens ?? tokenUsage.outputTokens,
                cacheReadTokens: res.usage.cache_read_input_tokens,
                cacheWriteTokens: res.usage.cache_creation_input_tokens,
              };
            }
            debug(`result subtype=${res.subtype}`);
            // A result message ends the whole query (single-turn) or follows
            // an interrupt. Emit terminal chunks to whatever turn is active.
            if (turn) {
              turn.push({ type: "usage", usage: tokenUsage });
              turn.push({ type: "finish", reason: { kind: "stop" } });
              turn.finish();
              session.currentTurn = null;
            }
          }
          continue;
        }

        if (!turn) continue; // between turns; drop transient events

        if (process.env.CLAUDE_BRIDGE_DEBUG) {
          const ev = event as { type?: string; index?: number; delta?: { type?: string } };
          debug(`event ${ev.type} index=${ev.index ?? "-"} delta=${ev.delta?.type ?? "-"}`);
        }

        if (event.type === "message_start") {
          nextBlockIndex = 0;
          turnSawToolCall = false;
          activeBlocks.clear();
          const usage = (event.message as { usage?: Record<string, number> })?.usage;
          if (usage) {
            tokenUsage.inputTokens = usage.input_tokens ?? 0;
            if (usage.cache_read_input_tokens)
              tokenUsage.cacheReadTokens = usage.cache_read_input_tokens;
            if (usage.cache_creation_input_tokens)
              tokenUsage.cacheWriteTokens = usage.cache_creation_input_tokens;
          }
        } else if (event.type === "content_block_start") {
          const rawBlock = event.content_block as { type: string; id?: string; name?: string };
          const index = nextBlockIndex++;
          const eventIndex = (event.index as number) ?? index;

          if (rawBlock?.type === "text") {
            activeBlocks.set(eventIndex, { index, type: "text", text: "" });
            turn.push({ type: "block-start", index, blockType: "text" });
          } else if (rawBlock?.type === "thinking") {
            activeBlocks.set(eventIndex, { index, type: "reasoning", text: "" });
            turn.push({ type: "block-start", index, blockType: "reasoning" });
          } else if (rawBlock?.type === "tool_use") {
            const callId = makeCallId(rawBlock.id || `call_${Date.now()}`);
            const cleanName = normalizeToolName(rawBlock.name);
            activeBlocks.set(eventIndex, {
              index,
              type: "tool-call",
              text: "",
              toolCallId: callId,
              toolName: cleanName,
              partialJson: "",
            });
            turn.push({ type: "block-start", index, blockType: "tool-call" });
            turn.push({
              type: "tool-call-delta",
              index,
              id: callId,
              name: cleanName,
              argumentsDelta: "",
            });
          }
        } else if (event.type === "content_block_delta") {
          const block = activeBlocks.get(event.index as number);
          if (!block) continue;
          const delta = event.delta as Record<string, string>;
          if (delta?.type === "text_delta" && block.type === "text") {
            block.text += delta.text;
            turn.push({ type: "text-delta", index: block.index, text: delta.text });
          } else if (delta?.type === "thinking_delta" && block.type === "reasoning") {
            block.text += delta.thinking;
            turn.push({ type: "reasoning-delta", index: block.index, text: delta.thinking });
          } else if (delta?.type === "input_json_delta" && block.type === "tool-call") {
            block.partialJson = (block.partialJson || "") + delta.partial_json;
            turn.push({
              type: "tool-call-delta",
              index: block.index,
              id: block.toolCallId as never,
              argumentsDelta: delta.partial_json,
            });
          }
        } else if (event.type === "content_block_stop") {
          const block = activeBlocks.get(event.index as number);
          if (!block) continue;
          activeBlocks.delete(event.index as number);

          let finalBlock: ContentBlock;
          if (block.type === "text") {
            finalBlock = { type: "text", text: block.text };
          } else if (block.type === "reasoning") {
            finalBlock = { type: "reasoning", text: block.text };
          } else {
            finalBlock = {
              type: "tool-call",
              id: block.toolCallId as never,
              name: block.toolName || "",
              arguments: block.partialJson || "{}",
            };
          }
          turn.push({ type: "block-end", index: block.index, block: finalBlock });
          if (finalBlock.type === "tool-call") {
            // Do NOT end the turn here: one assistant message can carry
            // several tool_use blocks. The turn ends at message_stop below
            // (pi-claude-bridge's processStreamEvent does the same), after
            // every block of the message has been flushed. The MCP handler
            // parks on the real result, and DSH drives execution.
            turnSawToolCall = true;
          }
        } else if (event.type === "message_stop") {
          // End of the assistant message. If it contained tool calls, the
          // turn ends now with every tool-call block emitted; the MCP
          // handlers park until the next stream() call delivers DSH's real
          // results. The subprocess stays alive — no interrupt, no broken
          // transcript. Plain-text turns finish on the `result` message.
          if (turnSawToolCall) {
            turn.push({ type: "usage", usage: tokenUsage });
            turn.push({ type: "finish", reason: { kind: "tool-calls" } });
            turn.finish();
            session.currentTurn = null;
            turnSawToolCall = false;
          }
        }
      }
      // Iterator ended: subprocess closed the stream.
      throw new Error("claude-bridge: Claude Code query stream ended");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      debug(`consumer died: ${error.message}`);
      session.dead = error;
      for (const p of session.pendingToolCalls.values()) p.reject(error);
      session.pendingToolCalls.clear();
      session.currentTurn?.fail(error);
      session.promptStream.fail(error);
      this.sessions.delete(dshSessionId);
    }
  }
}
