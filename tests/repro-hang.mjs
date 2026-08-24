// Reproduce the workflow-child first-turn shape: 3 user messages in one turn.
import { ClaudeBridgeAdapter } from "../lib/index.js";

const config = {
  plan: "max",
  longContextExtraUsage: false,
  strictMcpConfig: true,
  autoMemoryEnabled: false,
  pathToClaudeCodeExecutable: "/home/jaco/.local/bin/claude",
};

const adapter = new ClaudeBridgeAdapter(() => config);

const messages = [
  { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "What is 17 * 23? Compute it step by step, then answer with just the number." }] },
  { role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: danger-full-access." }] },
  { role: "user", source: { kind: "skill-catalog" }, content: [{ type: "text", text: "<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>" }] },
];

const timeout = setTimeout(() => {
  console.error("TIMEOUT after 60s — adapter.stream() hung");
  process.exit(2);
}, 60000);

console.log("starting stream...");
let chunks = 0;
try {
  for await (const chunk of adapter.stream({
    sessionId: "repro-hang-1",
    model: "claude-bridge/claude-opus-5",
    messages,
    tools: [],
  })) {
    chunks++;
    if (chunk.type === "text") process.stdout.write(chunk.text ?? "");
    else console.log(`\n[chunk ${chunk.type}]`);
  }
  console.log(`\nDONE chunks=${chunks}`);
} catch (e) {
  console.error("ERROR:", e.message);
  process.exit(1);
} finally {
  clearTimeout(timeout);
}
