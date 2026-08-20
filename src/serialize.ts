import type { Message, ContentBlock, ToolSchema } from "@deepseek-ai/dsh-llm";
import type { Message as SessionMessage } from "cc-session-io";

export const PROVIDER_ID = "claude-bridge";

export function sanitizeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export interface ConvertedMessages {
  historyMessages: SessionMessage[];
  currentPrompt: string;
  currentPromptBlocks?: Array<Record<string, unknown>>;
}

export function convertDshMessages(
  messages: Message[],
  customToolNameToSdk?: Map<string, string>,
): ConvertedMessages {
  const sessionMessages: SessionMessage[] = [];
  let currentPrompt = "";
  let currentPromptBlocks: Array<Record<string, unknown>> | undefined;

  // Find the last user turn (the trailing prompt for query()). A tool-result
  // message is also a user turn: it is the most recent user message, so
  // everything before it is history and it must be replayed in the session,
  // not skipped by the old "last non-tool user message" heuristic.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const history = lastUserIdx >= 0 ? messages.slice(0, lastUserIdx) : messages;
  const currentMsg = lastUserIdx >= 0 ? messages[lastUserIdx] : undefined;

  if (currentMsg && currentMsg.role === "user") {
    const textBlocks: string[] = [];
    const richBlocks: Array<Record<string, unknown>> = [];

    for (const block of currentMsg.content) {
      if (block.type === "text") {
        textBlocks.push(block.text);
        richBlocks.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        // Handle image blocks
        richBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: block.attachment.mediaType || "image/png",
            data: block.attachment.attachmentId,
          },
        });
      }
    }
    currentPrompt = textBlocks.join("\n");
    if (richBlocks.length > 1 || richBlocks.some((b) => b.type === "image")) {
      currentPromptBlocks = richBlocks;
    }
  }

  // If the last user message is a tool-result with no text prompt, replay it
  // in history (so the model sees the real result) and use a continuation
  // prompt, rather than re-answering the original question that preceded it.
  if (currentMsg && currentMsg.role === "user") {
    const toolResults = currentMsg.content.filter((b) => b.type === "tool-result");
    const hasText = currentMsg.content.some((b) => b.type === "text" && b.text);
    if (toolResults.length > 0 && !hasText) {
      currentPrompt = "(continue)";
      history.push(currentMsg);
    }
  }

  let turnResults: Array<Record<string, unknown>> | null = null;

  for (const msg of history) {
    if (msg.role === "system") {
      continue;
    }

    if (msg.role === "user") {
      const toolResults = msg.content.filter((b) => b.type === "tool-result");
      const textBlocks = msg.content.filter((b) => b.type === "text");

      if (toolResults.length > 0) {
        // Tool results message
        const resultBlocks: Array<Record<string, unknown>> = [];
        for (const tr of toolResults) {
          const resText = flattenText(tr.content) || "(no output)";
          resultBlocks.push({
            type: "tool_result",
            tool_use_id: sanitizeToolId(tr.toolCallId),
            content: resText,
            is_error: tr.isError ?? false,
          });
        }
        if (turnResults) {
          turnResults.push(...resultBlocks);
        } else {
          turnResults = resultBlocks;
          sessionMessages.push({ role: "user", content: turnResults as any });
        }
      } else {
        turnResults = null;
        const text = textBlocks.map((b) => b.text).join("\n") || "[empty]";
        sessionMessages.push({ role: "user", content: text });
      }
    } else if (msg.role === "assistant") {
      turnResults = null;
      const blocks: Array<Record<string, unknown>> = [];

      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "reasoning" && block.text) {
          blocks.push({ type: "thinking", thinking: block.text });
        } else if (block.type === "tool-call") {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(block.arguments);
          } catch {}
          const mappedName = customToolNameToSdk?.get(block.name) ?? block.name;
          blocks.push({
            type: "tool_use",
            id: sanitizeToolId(block.id),
            name: mappedName,
            input: args,
          });
        }
      }

      if (blocks.length > 0) {
        sessionMessages.push({ role: "assistant", content: blocks as any });
      }
    }
  }

  return {
    historyMessages: sessionMessages,
    currentPrompt: currentPrompt || "(continue)",
    currentPromptBlocks,
  };
}
