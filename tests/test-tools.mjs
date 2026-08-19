import { ClaudeBridgeAdapter } from "../lib/adapter.js";

async function run() {
  console.log("=== Testing ClaudeBridgeAdapter Tool Calling ===");
  const config = {
    plan: "max",
    longContextExtraUsage: false,
    strictMcpConfig: true,
    autoMemoryEnabled: false,
    pathToClaudeCodeExecutable: "/home/jaco/.local/bin/claude",
  };

  const adapter = new ClaudeBridgeAdapter(() => config);

  const options = {
    provider: "claude-bridge",
    model: "claude-haiku-4-5",
    tools: [
      {
        name: "get_weather",
        description: "Get the current weather for a city",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
          },
          required: ["city"],
        },
      },
    ],
    messages: [
      {
        id: "msg_1",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "What is the weather in Brussels right now? Please use the get_weather tool." }],
      },
    ],
  };

  console.log("Sending prompt with tool schema...");
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === "block-start") {
      console.log(`[block-start: ${chunk.blockType} #${chunk.index}]`);
    } else if (chunk.type === "tool-call-delta") {
      console.log(`[tool-call-delta #${chunk.index} id=${chunk.id} name=${chunk.name} delta=${chunk.argumentsDelta}]`);
    } else if (chunk.type === "text-delta") {
      process.stdout.write(chunk.text);
    } else if (chunk.type === "block-end") {
      console.log(`\n[block-end #${chunk.index}]`, JSON.stringify(chunk.block));
    } else if (chunk.type === "finish") {
      console.log("[finish]", chunk.reason);
    }
  }

  console.log("\n=== Done ===");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
