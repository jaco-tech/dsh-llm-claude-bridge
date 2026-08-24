import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { Config } from "./config.js";
import {
  listClaudeBridgeModels,
  resolveClaudeBridgeModelInfo,
  resolveContextWindow,
} from "./models.js";
import { convertDshMessages, flattenText, sanitizeToolId } from "./serialize.js";
import { toolsToBridgeDefs } from "./mcp-server.js";
import { LiveSessionManager } from "./live-session.js";

export class ClaudeBridgeAdapter extends LlmAdapter {
  private configSource: () => Config;
  private liveSessions: LiveSessionManager;

  constructor(configSource: () => Config) {
    super();
    this.configSource = configSource;
    this.liveSessions = new LiveSessionManager(configSource);
  }

  /** Close every live Claude Code subprocess (tests / plugin teardown). */
  async dispose(): Promise<void> {
    await this.liveSessions.destroyAll();
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: "Claude Bridge (Claude Code Subscription)",
    };
  }

  override async listModels(provider: string): Promise<LlmModelInfo[]> {
    return listClaudeBridgeModels(provider, this.configSource());
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return resolveClaudeBridgeModelInfo(provider, model, this.configSource());
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { cliModelId } = resolveContextWindow(options.model, this.configSource());
    const cwd = process.cwd();
    const dshSessionId = options.sessionId || "default";

    if (process.env.CLAUDE_BRIDGE_DEBUG) {
      const dump = (options.messages ?? []).map((m, i) => ({
        i,
        role: m.role,
        kind: m.source?.kind,
        blockTypes: m.content?.map((b: { type: string }) => b.type),
        textHead: (m.content ?? [])
          .filter((b: { type: string }) => b.type === "text")
          .map((b) => (b as { text: string }).text.slice(0, 120))
          .join(" | ")
          .slice(0, 200),
      }));
      const line =
        `[cb-debug] stream sessionId=${dshSessionId} msgs=${options.messages?.length} ` +
        `live=${this.liveSessions.has(dshSessionId)} signal=${Boolean(options.signal)} tools=${options.tools?.length ?? 0}\n` +
        `[cb-debug] messages=${JSON.stringify(dump)}`;
      console.error(line);
      try {
        const fs = await import("node:fs");
        fs.appendFileSync("/tmp/cb-debug.log", line + "\n");
      } catch {}
    }

    const { currentPrompt, currentPromptBlocks } = convertDshMessages(options.messages);

    // Extract tool results from the trailing user turn: they resolve the
    // MCP handlers parked by the previous turn's tool calls.
    const toolResults: Array<{ callId: string; text: string; isError?: boolean }> = [];
    for (let i = options.messages.length - 1; i >= 0; i--) {
      const msg = options.messages[i];
      if (msg.role !== "user") break;
      for (const block of msg.content) {
        if (block.type === "tool-result") {
          toolResults.unshift({
            callId: sanitizeToolId(block.toolCallId),
            text: flattenText(block.content) || "(no output)",
            isError: block.isError ?? false,
          });
        }
      }
    }

    const isContinuation = this.liveSessions.has(dshSessionId);

    const session = this.liveSessions.ensure(dshSessionId, {
      cliModelId,
      cwd,
      system: options.system,
      reasoningEffort: options.reasoningEffort,
      tools: toolsToBridgeDefs(options.tools, async () => {
        // Unreachable: LiveSessionManager wraps handlers itself.
        return { toolCallId: "", content: "" };
      }),
    });

    // Arm this turn's pump BEFORE releasing any parked MCP handlers — the
    // subprocess's continuation events must land in this turn, not the void.
    const turnStream = this.liveSessions.beginTurn(session);

    // Wire cancellation for this turn only; the subprocess survives.
    const onAbort = () => {
      void session.sdkQuery.interrupt().catch(() => {});
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      if (isContinuation && toolResults.length > 0) {
        const unmatched = this.liveSessions.deliverToolResults(session, toolResults);
        if (unmatched.length > 0 && process.env.CLAUDE_BRIDGE_DEBUG) {
          const line = `[cb-debug] unmatched tool results: ${unmatched.join(",")}`;
          console.error(line);
          try {
            const fs = await import("node:fs");
            fs.appendFileSync("/tmp/cb-debug.log", line + "\n");
          } catch {}
        }
        // If the turn also carries a fresh text instruction (shouldn't in the
        // normal tool loop), push it after the results.
        if (currentPrompt && currentPrompt !== "(continue)") {
          await this.liveSessions.pushUserMessage(
            session,
            currentPrompt,
            session.capturedSessionId ?? dshSessionId,
          );
        }
      } else {
        // First turn of a session (or a plain follow-up): push the prompt.
        // Content-block prompts (images) are NOT supported on the streaming
        // input channel — fail fast instead of silently dropping non-text
        // blocks and sending an incomplete prompt to the subprocess.
        if (currentPromptBlocks?.some((b) => b.type !== "text")) {
          throw new Error(
            "claude-bridge: image/non-text prompts are not supported on the live session channel",
          );
        }
        const text = currentPromptBlocks
          ? currentPromptBlocks.map((b) => String(b.text ?? "")).join("\n")
          : currentPrompt;
        await this.liveSessions.pushUserMessage(
          session,
          text,
          session.capturedSessionId ?? dshSessionId,
        );
      }

      yield* turnStream;
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    }
  }
}
