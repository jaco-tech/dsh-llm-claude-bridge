// Full call -> real result -> follow-up turn round trip.
// Simulates what DeepSeek Harness' agent loop does: it reads the tool-call
// chunk, runs the tool itself, appends a tool-result message, then calls
// stream() again with the result in history.

import { ClaudeBridgeAdapter } from "../lib/adapter.js";

const config = {
  plan: "max",
  longContextExtraUsage: false,
  strictMcpConfig: true,
  autoMemoryEnabled: false,
  pathToClaudeCodeExecutable: "/home/jaco/.local/bin/claude",
};

const adapter = new ClaudeBridgeAdapter(() => config);
const sessionId = `roundtrip-${Date.now()}`;

// Turn 1: ask a question that requires a tool, capture the tool call.
let messages = [
  {
    id: "m1",
    role: "user",
    source: { kind: "user" },
    content: [
      {
        type: "text",
        text: "What is the weather in Ghent? Use the get_weather tool and then report the temperature.",
      },
    ],
  },
];

console.log("=== Turn 1: elicit a tool call ===");
let callId = null;
let toolName = null;
let args = null;
for await (const chunk of adapter.stream({
  provider: "claude-bridge",
  model: "claude-haiku-4-5",
  sessionId,
  tools: [
    {
      name: "get_weather",
      description: "Get current temperature for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City" } },
        required: ["city"],
      },
    },
  ],
  messages,
})) {
  if (chunk.type === "tool-call-delta" && callId === null) {
    callId = chunk.id;
    toolName = chunk.name;
    process.stdout.write(`▶ tool-call name=${chunk.name}`);
  } else if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
    callId = chunk.block.id;
    toolName = chunk.block.name;
    args = chunk.block.arguments;
  } else if (chunk.type === "text-delta") {
    process.stdout.write(chunk.text);
  }
}
console.log("\n--- turn 1 done ---");

if (!callId || toolName !== "get_weather") {
  console.error("\nFAIL: turn 1 did not emit a get_weather tool call");
  await adapter.dispose(); process.exit(1);
}
console.log(`tool call: ${toolName} args=${args}\n`);

// Simulate DSH's agent loop: execute the tool, append the assistant message
// (with the tool-call block) and a user message carrying the tool result.
let toolArgs = {};
try { toolArgs = JSON.parse(args); } catch {}
const city = toolArgs.city || "Berlin";
const realResultText = `The current temperature in ${city} is 23°C and sunny.`;

messages.push({
  id: "m2",
  role: "assistant",
  source: { kind: "model", provider: "claude-bridge", model: "claude-haiku-4-5" },
  content: [{ type: "tool-call", id: callId, name: toolName, arguments: args }],
});
messages.push({
  id: "m3",
  role: "user",
  source: { kind: "tool", callId },
  content: [
    {
      type: "tool-result",
      toolCallId: callId,
      isError: false,
      content: [{ type: "text", text: realResultText }],
    },
  ],
});

console.log("=== Turn 2: real result in history, model should reference it ===");
let turn2Text = "";
for await (const chunk of adapter.stream({
  provider: "claude-bridge",
  model: "claude-haiku-4-5",
  sessionId,
  messages,
  tools: [
    {
      name: "get_weather",
      description: "Get current temperature for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City" } },
        required: ["city"],
      },
    },
  ],
})) {
  if (chunk.type === "text-delta") {
    turn2Text += chunk.text;
    process.stdout.write(chunk.text);
  }
}
console.log("\n--- turn 2 done ---");

const mentions = /23°C|23 C|twenty-three|sunny|23°/.test(turn2Text);
if (mentions) {
  console.log("\nSUCCESS: the model referenced the real tool result (23°C sunny) on follow-up.");
  await adapter.dispose(); process.exit(0);
} else {
  console.error("\nFAIL: model did not reference the real 23°C tool result in turn 2.");
  console.error("turn2Text:", JSON.stringify(turn2Text));
  await adapter.dispose(); process.exit(1);
}

function stream(opts) {
  return adapter.stream(opts);
}