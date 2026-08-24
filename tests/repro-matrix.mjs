// Phase-2: minimize. Which harness-shaped input turns the adapter seam red
// (stub "no prior work ... resume") for a long task? Vary one dimension at a time.
import { ClaudeBridgeAdapter } from "../lib/adapter.js";

const adapter = new ClaudeBridgeAdapter(() => ({
  plan: "max",
  longContextExtraUsage: false,
  strictMcpConfig: true,
  autoMemoryEnabled: false,
  pathToClaudeCodeExecutable: "/home/jaco/.local/bin/claude",
}));

const LONG_TASK = [
  "NEW TASK, no prior context. Execute immediately, end to end.",
  "DISPATCH (librarian persona): File /home/jaco/LDEV/dsh-test/DOC-UPDATING-DSH.md into steen-documentation as an OKF pack. TODAY is 2026-08-20.",
  "STEP 1 — read: /home/jaco/LDEV/steen-agentics/agents/librarian/AGENT.md, /home/jaco/LDEV/steen-documentation/standard/KNOWLEDGE-PACK.md, okf-validate/SKILL.md, pr-workflow/SKILL.md, README.md + AGENTS.md, list knowledge/.",
  "STEP 2 — triage: pick target pack, create-vs-update, dedupe. No silent contradictions.",
  "STEP 3 — author the OKF concept file(s) (frontmatter type/title/description/tags/timestamp 2026-08-20/resource) preserving ALL technical content; update index.md + log.md.",
  "STEP 4 — validate: python3 okf-validate/scripts/validate_okf.py <pack> --warnings-as-errors → 0 errors.",
  "STEP 5 — PR per pr-workflow: worktree off origin/main, commit, push, open PR with full Worker Report. Use gh.",
  "STEP 6 — end with EXACTLY the librarian Report block.",
].join("\n");

const SYSTEM = [
  "You are the LIBRARIAN agent from steen-agentics — the single intake for steen-documentation. Durable information arrives handed to you; you do NOT bulk-write content yourself.",
  "You TRIAGE each item: decide the target pack, decide update-vs-new-concept, dedupe and run a contradiction check, enforce index.md + log.md discipline.",
  "Then you DISPATCH a writer worker with a placement brief, run okf-validate (0 errors), and ship the PR. Placement judgment is centralized in you.",
  "Nobody writes into steen-documentation directly. Path = identity; never rename. Contradictions you cannot adjudicate escalate to the human owner — never resolve silently.",
].join("\n");

const TOOLS = [
  {
    name: "read",
    description: "Read a UTF-8 text file and return line-numbered content.",
    parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  },
  {
    name: "bash",
    description: "Execute a bash command and return its stdout/stderr.",
    parameters: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } }, required: ["command"] },
  },
  {
    name: "write",
    description: "Create or fully replace a UTF-8 text file.",
    parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] },
  },
];

async function run(label, opts) {
  const out = [];
  try {
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === "text-delta") out.push(chunk.text);
      else if (chunk.type === "finish") console.error(`  [${label} finish: ${JSON.stringify(chunk.reason)}]`);
    }
  } catch (e) {
    console.error(`[${label}] threw:`, e?.message?.slice(0, 160));
  }
  const text = out.join("");
  const addressed = /librarian|OKF|valid|workflow|pack|PR|execut/i.test(text) && text.length > 20;
  const stub = /no prior|resume|interrupted|no earlier|what would you like/i.test(text);
  console.log(`[${label}] len=${text.length} RED=${stub || !addressed}`);
  console.log(`    ${JSON.stringify(text.slice(0, 120))}`);
  return { label, text, red: stub || !addressed };
}

const base = {
  provider: "claude-bridge",
  model: "claude-opus-5",
  messages: [{ id: "m1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: LONG_TASK }] }],
};

const results = [];
results.push(await run("1-baseline(no sys/session/tools)", base));

const sys = { ...base, system: SYSTEM };
results.push(await run("2-with-system", sys));

const sess = { ...sys, sessionId: `repro-${Date.now()}` };
results.push(await run("3-system+sessionId", sess));

const tools = { ...sess, tools: TOOLS };
results.push(await run("4-system+session+tools", tools));

// duplicate 4 with fresh session to check resume-from-written-file path
const sess2 = { ...tools, sessionId: `repro-${Date.now()}-b` };
results.push(await run("5-system+session+tools(fresh)", sess2));

console.log("\nREDS:", results.filter((r) => r.red).map((r) => r.label).join(", ") || "none");
process.exit(results.some((r) => r.red) ? 1 : 0);
