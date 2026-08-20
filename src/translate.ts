import type {
  CallId,
  ContentBlock,
  FinishReason,
  StreamChunk,
  TokenUsage,
} from "@deepseek-ai/dsh-llm";
import { CallId as makeCallId } from "@deepseek-ai/dsh-llm";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

interface ActiveBlock {
  index: number;
  type: "text" | "reasoning" | "tool-call";
  text: string;
  toolCallId?: CallId;
  toolName?: string;
  partialJson?: string;
}

export function normalizeToolName(name: string | undefined): string {
  if (!name) return "";
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    if (parts.length >= 3) {
      return parts.slice(2).join("__");
    }
  }
  return name;
}

export async function* translateSdkQuery(
  sdkQuery: Query,
  signal?: AbortSignal,
  onSessionCaptured?: (sessionId: string) => void,
): AsyncGenerator<StreamChunk, void, unknown> {
  let nextBlockIndex = 0;
  const activeBlocks = new Map<number, ActiveBlock>();
  const closedBlocks: ContentBlock[] = [];
  let tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let pendingFinish: FinishReason | null = null;
  let sawToolCall = false;
  let capturedSession = false;

  try {
    for await (const message of sdkQuery) {
      if (!capturedSession && (message as any).session_id) {
        capturedSession = true;
        onSessionCaptured?.((message as any).session_id);
      }

      if (signal?.aborted) {
        pendingFinish = {
          kind: "aborted",
          failure: {
            message: "Operation aborted by caller",
            code: "ABORTED",
          },
        };
        break;
      }

      const event = (message as any).event;
      if (!event) {
        // High-level SDK result message
        if (message.type === "result") {
          const res = message as any;
          if (res.usage) {
            tokenUsage = {
              inputTokens: res.usage.input_tokens ?? tokenUsage.inputTokens,
              outputTokens: res.usage.output_tokens ?? tokenUsage.outputTokens,
              cacheReadTokens: res.usage.cache_read_input_tokens,
              cacheWriteTokens: res.usage.cache_creation_input_tokens,
            };
          }
        }
        continue;
      }

      if (event.type === "message_start") {
        if (event.message?.usage) {
          const u = event.message.usage;
          tokenUsage.inputTokens = u.input_tokens ?? 0;
          if (u.cache_read_input_tokens) tokenUsage.cacheReadTokens = u.cache_read_input_tokens;
          if (u.cache_creation_input_tokens) tokenUsage.cacheWriteTokens = u.cache_creation_input_tokens;
        }
      } else if (event.type === "content_block_start") {
        const rawBlock = event.content_block;
        const index = nextBlockIndex++;

        if (rawBlock?.type === "text") {
          const block: ActiveBlock = { index, type: "text", text: "" };
          activeBlocks.set(event.index ?? index, block);
          yield { type: "block-start", index, blockType: "text" };
        } else if (rawBlock?.type === "thinking") {
          const block: ActiveBlock = { index, type: "reasoning", text: "" };
          activeBlocks.set(event.index ?? index, block);
          yield { type: "block-start", index, blockType: "reasoning" };
        } else if (rawBlock?.type === "tool_use") {
          sawToolCall = true;
          const callId = makeCallId(rawBlock.id || `call_${Date.now()}`);
          const cleanName = normalizeToolName(rawBlock.name);
          const block: ActiveBlock = {
            index,
            type: "tool-call",
            text: "",
            toolCallId: callId,
            toolName: cleanName,
            partialJson: "",
          };
          activeBlocks.set(event.index ?? index, block);
          yield { type: "block-start", index, blockType: "tool-call" };
          yield {
            type: "tool-call-delta",
            index,
            id: callId,
            name: cleanName,
            argumentsDelta: "",
          };
        }
      } else if (event.type === "content_block_delta") {
        const block = activeBlocks.get(event.index);
        if (!block) continue;

        const delta = event.delta;
        if (delta?.type === "text_delta" && block.type === "text") {
          block.text += delta.text;
          yield { type: "text-delta", index: block.index, text: delta.text };
        } else if (delta?.type === "thinking_delta" && block.type === "reasoning") {
          block.text += delta.thinking;
          yield { type: "reasoning-delta", index: block.index, text: delta.thinking };
        } else if (delta?.type === "input_json_delta" && block.type === "tool-call") {
          block.partialJson = (block.partialJson || "") + delta.partial_json;
          yield {
            type: "tool-call-delta",
            index: block.index,
            id: block.toolCallId!,
            argumentsDelta: delta.partial_json,
          };
        }
      } else if (event.type === "content_block_stop") {
        const block = activeBlocks.get(event.index);
        if (!block) continue;
        activeBlocks.delete(event.index);

        let finalBlock: ContentBlock;
        if (block.type === "text") {
          finalBlock = { type: "text", text: block.text };
        } else if (block.type === "reasoning") {
          finalBlock = { type: "reasoning", text: block.text };
        } else {
          finalBlock = {
            type: "tool-call",
            id: block.toolCallId!,
            name: block.toolName || "",
            arguments: block.partialJson || "{}",
          };
          // OPTION C: end the turn at the tool_use boundary. Terminating the query
          // here prevents the subprocess from resolving the tool call against an MCP
          // placeholder — it never gets a fabricated result to continue from. DSH
          // runs the tool and the next turn resumes with the real result in history.
          sawToolCall = true;
        }
        closedBlocks.push(finalBlock);
        yield { type: "block-end", index: block.index, block: finalBlock };

        if (finalBlock.type === "tool-call") {
          break; // end stream at the tool-use boundary, before the subprocess resolves it
        }
      } else if (event.type === "message_delta") {
        if (event.usage) {
          tokenUsage.outputTokens = event.usage.output_tokens ?? tokenUsage.outputTokens;
        }
        const stopReason = event.delta?.stop_reason;
        if (stopReason === "tool_use" || sawToolCall) {
          pendingFinish = { kind: "tool-calls" };
        } else if (stopReason === "max_tokens") {
          pendingFinish = { kind: "max-tokens" };
        } else if (stopReason === "end_turn" || stopReason === "stop_sequence") {
          pendingFinish = { kind: "stop" };
        }
      }
    }
  } catch (err: any) {
    if (signal?.aborted) {
      pendingFinish = {
        kind: "aborted",
        failure: {
          message: "Operation aborted by caller",
          code: "ABORTED",
        },
      };
    } else {
      pendingFinish = {
        kind: "error",
        failure: {
          message: err?.message || "Claude Agent SDK query failed",
          code: err?.code || "PROVIDER_ERROR",
        },
      };
    }
  } finally {
    // Flush any remaining unclosed blocks
    for (const [_, block] of activeBlocks) {
      let finalBlock: ContentBlock;
      if (block.type === "text") {
        finalBlock = { type: "text", text: block.text };
      } else if (block.type === "reasoning") {
        finalBlock = { type: "reasoning", text: block.text };
      } else {
        finalBlock = {
          type: "tool-call",
          id: block.toolCallId!,
          name: block.toolName || "",
          arguments: block.partialJson || "{}",
        };
      }
      yield { type: "block-end", index: block.index, block: finalBlock };
    }

    // Emit usage before finish
    yield { type: "usage", usage: tokenUsage };

    // Emit final finish chunk
    const finalReason = pendingFinish ?? (sawToolCall ? { kind: "tool-calls" } : { kind: "stop" });
    yield {
      type: "finish",
      reason: finalReason,
    };
  }
}
