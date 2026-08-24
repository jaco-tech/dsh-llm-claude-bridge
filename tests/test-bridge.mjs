import { ClaudeBridgeAdapter } from "../lib/adapter.js";
import { Config } from "../lib/config.js";

let adapter;

async function run() {
  console.log("=== Testing ClaudeBridgeAdapter ===");
  const config = {
    plan: "max",
    longContextExtraUsage: false,
    strictMcpConfig: true,
    autoMemoryEnabled: false,
    pathToClaudeCodeExecutable: "/home/jaco/.local/bin/claude",
  };

  adapter = new ClaudeBridgeAdapter(() => config);

  console.log("1. Provider Info:", adapter.providerInfo("claude-bridge"));

  const models = await adapter.listModels("claude-bridge");
  console.log(`2. Models (${models.length}):`, models.map((m) => `${m.id} (${m.name})`));

  const resolved = await adapter.resolveModel("claude-bridge", "claude-sonnet-4-6");
  console.log("3. Resolved claude-sonnet-4-6:", {
    id: resolved.id,
    name: resolved.name,
    contextWindow: resolved.context?.contextWindow,
    reasoning: resolved.reasoning?.efforts?.map((e) => e.id),
  });

  console.log("4. Testing stream() with a simple prompt...");
  const options = {
    provider: "claude-bridge",
    model: "claude-haiku-4-5",
    messages: [
      {
        id: "msg_1",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "Say 'Hello from Claude Bridge!' in exactly one sentence." }],
      },
    ],
  };

  const chunks = [];
  for await (const chunk of adapter.stream(options)) {
    chunks.push(chunk);
    if (chunk.type === "text-delta") {
      process.stdout.write(chunk.text);
    } else if (chunk.type === "block-start") {
      console.log(`\n[block-start: ${chunk.blockType} #${chunk.index}]`);
    } else if (chunk.type === "block-end") {
      console.log(`\n[block-end #${chunk.index}]`);
    } else if (chunk.type === "usage") {
      console.log("\n[usage]", chunk.usage);
    } else if (chunk.type === "finish") {
      console.log("\n[finish]", chunk.reason);
    }
  }

  console.log("\n=== Done ===");
}

run()
  .then(async () => { await adapter.dispose(); process.exit(0); })
  .catch(async (err) => {
    console.error("Test failed:", err);
    try { await adapter.dispose(); } catch {}
    process.exit(1);
  });
