// Regression test for the multi-tool_use-per-message bug.
// Before the fix, the bridge ended the turn at the FIRST tool-call's
// content_block_stop; the second tool_use block's events were dropped, its
// MCP handler parked forever, and Claude Code died with
// error_during_execution (stop_reason=tool_use).
//
// This test elicits TWO tool calls in ONE assistant message, delivers both
// real results, and expects a successful follow-up referencing both.

import { ClaudeBridgeAdapter } from "../lib/adapter.js";

const config = {
  plan: "max",
  longContextExtraUsage: false,
  strictMcpConfig: true,
  autoMemoryEnabled: false,
  pathToClaudeCodeExecutable: "/home/jaco/.local/bin/claude",
};

const adapter = new ClaudeBridgeAdapter(() => config);
const sessionId = `parallel-${Date.now()}`;

const tools = [
  {
    name: "get_weather",
    description: "Get current temperature for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City" } },
      required: ["city"],
    },
  },
  {
    name: "get_population",
    description: "Get population of a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City" } },
      required: ["city"],
    },
  },
];

let messages = [
  {
    id: "m1",
    role: "user",
    source: { kind: "user" },
    content: [
      {
        type: "text",
        text:
          "Call get_weather for Ghent AND get_population for Ghent. " +
          "IMPORTANT: issue BOTH tool calls in a single response, in parallel — do not wait for the first result. " +
          "Then report both numbers.",
      },
    ],
  },
];

console.log("=== Turn 1: elicit TWO parallel tool calls in one message ===");
const calls = new Map(); // id -> {name, args}
let finishReason = null;
for await (const chunk of adapter.stream({
  provider: "claude-bridge",
  model: "claude-haiku-4-5",
  sessionId,
  tools,
  messages,
})) {
  if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
    calls.set(chunk.block.id, { name: chunk.block.name, args: chunk.block.arguments });
    console.log(`▶ tool-call ${chunk.block.name} id=${chunk.block.id} args=${chunk.block.arguments}`);
  } else if (chunk.type === "finish") {
    finishReason = chunk.reason?.kind;
  }
}

console.log(`finish reason: ${finishReason}, tool calls captured: ${calls.size}`);

if (calls.size < 2) {
  console.log("NOTE: model did not emit parallel calls this run — retrying with a forced nudge is fine, but the bug only reproduces with 2+ calls in one message.");
  await adapter.dispose(); process.exit(2);
}

// Turn 2: deliver BOTH real results.
const assistantBlocks = [...calls.entries()].map(([id, c]) => ({
  type: "tool-call",
  id,
  name: c.name,
  arguments: c.args,
}));
messages = [
  ...messages,
  { id: "m2", role: "assistant", source: { kind: "model" }, content: assistantBlocks },
  {
    id: "m3",
    role: "user",
    source: { kind: "tool" },
    content: [...calls.entries()].map(([id, c]) => ({
      type: "tool-result",
      toolCallId: id,
      content: [
        {
          type: "text",
          text: c.name === "get_weather" ? "23°C, sunny" : "265,000 inhabitants",
        },
      ],
      isError: false,
    })),
  },
];

console.log("=== Turn 2: deliver both results, expect a summary ===");
let text = "";
let failed = null;
try {
  for await (const chunk of adapter.stream({
    provider: "claude-bridge",
    model: "claude-haiku-4-5",
    sessionId,
    tools,
    messages,
  })) {
    if (chunk.type === "text-delta") {
      text += chunk.text;
      process.stdout.write(chunk.text);
    }
  }
} catch (err) {
  failed = err;
}
console.log();

if (failed) {
  console.log(`FAIL: follow-up turn errored: ${failed.message}`);
  await adapter.dispose(); process.exit(1);
}
if (/23/.test(text) && /265/.test(text)) {
  console.log("SUCCESS: both parallel tool results delivered; model referenced both (23°C and 265,000).");
  await adapter.dispose(); process.exit(0);
}
console.log(`FAIL: model answer did not reference both results. Got: ${text.slice(0, 300)}`);
await adapter.dispose(); process.exit(1);
