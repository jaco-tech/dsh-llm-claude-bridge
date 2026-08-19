import { ClaudeBridgeAdapter } from "../lib/adapter.js";

async function run() {
  console.log("=== Testing ClaudeBridgeAdapter Multi-Turn Session Continuity ===");
  const config = {
    plan: "max",
    longContextExtraUsage: false,
    strictMcpConfig: true,
    autoMemoryEnabled: false,
    pathToClaudeCodeExecutable: "/home/jaco/.local/bin/claude",
  };

  const adapter = new ClaudeBridgeAdapter(() => config);

  const sessionId = "test-session-123";
  const messages = [
    {
      id: "msg_1",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "My secret code is BLUE-HORSE-42. Remember it." }],
    },
  ];

  console.log("Turn 1: Telling Claude the secret code...");
  let turn1Text = "";
  for await (const chunk of adapter.stream({
    provider: "claude-bridge",
    model: "claude-haiku-4-5",
    sessionId,
    messages,
  })) {
    if (chunk.type === "text-delta") {
      turn1Text += chunk.text;
      process.stdout.write(chunk.text);
    }
  }
  console.log("\n--- Turn 1 completed ---\n");

  // Add assistant message and next user question to messages
  messages.push({
    id: "msg_2",
    role: "assistant",
    source: { kind: "model", provider: "claude-bridge", model: "claude-haiku-4-5" },
    content: [{ type: "text", text: turn1Text }],
  });
  messages.push({
    id: "msg_3",
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: "What is my secret code?" }],
  });

  console.log("Turn 2: Asking for the secret code...");
  let turn2Text = "";
  for await (const chunk of adapter.stream({
    provider: "claude-bridge",
    model: "claude-haiku-4-5",
    sessionId,
    messages,
  })) {
    if (chunk.type === "text-delta") {
      turn2Text += chunk.text;
      process.stdout.write(chunk.text);
    }
  }
  console.log("\n--- Turn 2 completed ---\n");

  if (turn2Text.includes("BLUE-HORSE-42")) {
    console.log("SUCCESS: Claude remembered the secret code across turns!");
  } else {
    console.log("FAILURE: Claude did not remember the secret code.");
  }
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
