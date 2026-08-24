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

  // Find the start of the current turn: the trailing run of user messages.
  // A workflow/subagent child seats the task prompt PLUS harness-injected user
  // messages (runtime-context, skill catalog) in a single turn — the whole
  // trailing run is the live prompt; only messages before it are history.
  // Taking just the last user message (the old heuristic) splits the first
  // turn into "history" + a content-free prompt, forcing syncSession down the
  // synthetic-rebuild path and handing Claude Code a resume of an empty,
  // hand-written session — which it reads as an aborted session, producing the
  // "no prior work ... interrupted" stub. Mirrors pi-claude-bridge's
  // turnStart() (upstream issue #34).
  let turnStartIdx = messages.length;
  while (turnStartIdx > 0 && messages[turnStartIdx - 1].role === "user") {
    turnStartIdx--;
  }
  const lastUserIdx = turnStartIdx < messages.length ? turnStartIdx : -1;

  const history = lastUserIdx >= 0 ? messages.slice(0, lastUserIdx) : messages;
  const currentTurn = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : [];

  if (currentTurn.length > 0) {
    const textBlocks: string[] = [];
    const richBlocks: Array<Record<string, unknown>> = [];

    for (const msg of currentTurn) {
      for (const block of msg.content) {
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
    }
    currentPrompt = textBlocks.join("\n");
    // Only fall back to a content-block prompt when the turn actually carries
    // an image. A multi-block text prompt (`ContentBlockParam[]`) deadlocks
    // the Agent SDK's in-process MCP server negotiation (SDK 0.3.x): query()
    // never emits its first message and the child hangs with no subprocess
    // output. Plain-text turns must go as a joined string.
    if (richBlocks.some((b) => b.type === "image")) {
      currentPromptBlocks = richBlocks;
    }
  }

  // If the last user message is a tool-result with no text prompt, replay it
  // in history (so the model sees the real result) and use a continuation
  // prompt, rather than re-answering the original question that preceded it.
  // If the current turn is tool-results with no text prompt, replay those
  // messages in history (so the model sees the real results) and use a
  // continuation prompt, rather than re-answering the question that preceded
  // them. Only the tool-result-bearing messages move; any trailing text
  // messages stay in the prompt.
  const turnToolResults = currentTurn.filter(
    (msg) =>
      msg.content.some((b) => b.type === "tool-result") &&
      !msg.content.some((b) => b.type === "text" && b.text),
  );
  if (turnToolResults.length > 0 && currentPrompt === "") {
    currentPrompt = "(continue)";
    history.push(...currentTurn);
    currentPromptBlocks = undefined;
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
