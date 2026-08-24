// Phase-1 feedback loop: does the claude-bridge adapter alone (bypassing the
// DSH workflow dispatcher) reproduce the "long prompt -> no-op" symptom?
//
// Verdicts:
//   short: expect OK  (probe works through the adapter too)
//   long:  OK => the adapter seam is fine; bug is upstream (harness/dispatch)
//          RED => the adapter itself drops long prompts; bridge bug
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
  "",
  "DISPATCH (librarian persona): File /home/jaco/LDEV/dsh-test/DOC-UPDATING-DSH.md into steen-documentation as an OKF pack. TODAY is 2026-08-20 — use it for all timestamps.",
  "",
  "STEP 1 — read these, in order:",
  "- /home/jaco/LDEV/steen-agentics/agents/librarian/AGENT.md",
  "- /home/jaco/LDEV/steen-documentation/standard/KNOWLEDGE-PACK.md",
  "- /home/jaco/LDEV/steen-agentics/skills/okf-validate/SKILL.md",
  "- /home/jaco/LDEV/steen-agentics/skills/pr-workflow/SKILL.md",
  "- /home/jaco/LDEV/steen-documentation/README.md + AGENTS.md",
  "- list /home/jaco/LDEV/steen-documentation/knowledge/ for dedupe + pack taxonomy",
  "",
  "STEP 2 — triage the intake (read it fully): pick target pack (existing fit like system-behavior, or new dsh-operations), create-vs-update, dedupe. No silent contradictions.",
  "",
  "STEP 3 — author the OKF concept file(s): frontmatter (type/title/description/tags/timestamp 2026-08-20/resource) + body preserving ALL technical content incl. the three post-install breakages + repairs and the troubleshooting table. Update index.md + log.md (log dated 2026-08-20).",
  "",
  "STEP 4 — validate: python3 /home/jaco/LDEV/steen-agentics/skills/okf-validate/scripts/validate_okf.py <pack> --warnings-as-errors → 0 errors. Fix to green.",
  "",
  "STEP 5 — PR per pr-workflow: the main checkout is on docs/incident-conversation-bridge-intake (do not disturb). Make a worktree off origin/main named docs/<slug>, work there, re-validate, commit, push, open a PR with the full Worker Report. Use gh.",
  "",
  "STEP 6 — end with EXACTLY the librarian Report block (STATUS: placed|partial|escalated; Items table; Metadata: dispatcher-attested model per your run, agentics_version, agent: librarian@<commit>).",
].join("\n");

const SHORT_TASK = "This is a trivial routing probe. Respond with exactly the single word: ROUTED-OK. Do not mention sessions or resumes — there is none.";

async function run(name, prompt) {
  const out = [];
  try {
    for await (const chunk of adapter.stream({
      provider: "claude-bridge",
      model: "claude-opus-5",
      messages: [
        {
          id: "m1",
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: prompt }],
        },
      ],
    })) {
      if (chunk.type === "text-delta") out.push(chunk.text);
      else if (chunk.type === "finish") console.error(`  [${name} finish: ${JSON.stringify(chunk.reason)}]`);
    }
  } catch (e) {
    console.error(`[${name}] threw:`, e?.message);
  }
  const text = out.join("");
  const addressed = /librarian|OKF|valid|workflow|pack|PR/.test(text);
  const stub = /no prior|resume|interrupted|no earlier/i.test(text);
  console.log(`[${name}] len=${text.length} addressedTask=${addressed} stubLike=${stub}`);
  console.log(`--- ${name} reply (first 240) ---`);
  console.log(text.slice(0, 240));
  console.log("-----------------------------");
  return { name, text, addressed, stub };
}

const out = {};
out.short = await run("short", SHORT_TASK);
out.long = await run("long", LONG_TASK);

const longOK = out.long.addressed && !out.long.stub;
const shortOK = out.short.addressed && !out.short.stub;
console.log(
  `\nVERDICT: short=${shortOK ? "OK" : "RED"} long=${longOK ? "OK (no bug at adapter seam — check harness)" : "RED (adapter reproduces the stub — bridge bug)"}`,
);
process.exit(longOK ? 0 : 1);
