import z from "@deepseek-ai/schemastery";

export interface Config {
  /** Anthropic subscription plan tier: "pro" or "max" (enables 1M context on Opus 4.6). */
  plan: "pro" | "max";
  /** Enable 1M context models if they incur extra usage billing on your plan. */
  longContextExtraUsage: boolean;
  /** Block MCP servers from ~/.claude.json / .mcp.json (default true). */
  strictMcpConfig: boolean;
  /** Enable Claude Code auto-memory system (default false). */
  autoMemoryEnabled: boolean;
  /** Optional custom absolute path to the claude CLI binary. */
  pathToClaudeCodeExecutable?: string;
}

export const Config = z.object({
  plan: z.union([z.const("pro" as const), z.const("max" as const)]).default("max").description("Subscription plan tier (pro or max)"),
  longContextExtraUsage: z.boolean().default(false).description("Enable 1M context even with Extra Usage billing"),
  strictMcpConfig: z.boolean().default(true).description("Block MCP servers from ~/.claude.json and .mcp.json"),
  autoMemoryEnabled: z.boolean().default(false).description("Enable Claude Code auto-memory"),
  pathToClaudeCodeExecutable: z.string().description("Custom path to claude binary (optional)"),
}) as unknown as z<Config>;
