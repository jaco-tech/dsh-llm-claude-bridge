import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { query, type EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import {
  listClaudeBridgeModels,
  resolveClaudeBridgeModelInfo,
  resolveContextWindow,
} from "./models.js";
import { convertDshMessages } from "./serialize.js";
import { createMcpToolServer, toolsToBridgeDefs } from "./mcp-server.js";
import { SessionManager } from "./session.js";
import { translateSdkQuery } from "./translate.js";

const CC_CHILD_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
} as const;

export class ClaudeBridgeAdapter extends LlmAdapter {
  private configSource: () => Config;
  private sessionManager = new SessionManager();

  constructor(configSource: () => Config) {
    super();
    this.configSource = configSource;
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: "Claude Bridge (Claude Code Subscription)",
    };
  }

  override async listModels(provider: string): Promise<LlmModelInfo[]> {
    return listClaudeBridgeModels(provider, this.configSource());
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return resolveClaudeBridgeModelInfo(provider, model, this.configSource());
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const config = this.configSource();
    const { cliModelId } = resolveContextWindow(options.model, config);
    const cwd = process.cwd();

    // Convert conversation history
    const { historyMessages, currentPrompt, currentPromptBlocks } = convertDshMessages(
      options.messages,
    );

    // Sync session state to disk for resumption
    const resumeSessionId = await this.sessionManager.syncSession(
      options.sessionId,
      historyMessages,
      cwd,
      cliModelId,
    );

    // Setup in-process MCP server for DSH tools
    const mcpTools = toolsToBridgeDefs(options.tools, async (callId, name, args) => {
      // Return placeholder result to unblock MCP call; DSH loop will handle actual execution
      return {
        toolCallId: callId,
        content: `(Tool ${name} dispatched to DSH loop)`,
      };
    });

    const mcpServers = mcpTools.length > 0
      ? { "dsh-tools": createMcpToolServer("dsh-tools", mcpTools) }
      : undefined;

    // Map reasoning effort to Agent SDK EffortLevel
    let effort: EffortLevel | undefined;
    if (options.reasoningEffort && options.reasoningEffort !== "off") {
      effort = options.reasoningEffort as EffortLevel;
    }

    const extraArgs: Record<string, string | null> = { model: cliModelId };
    if (config.strictMcpConfig) {
      extraArgs["strict-mcp-config"] = null;
    }
    if (effort) {
      extraArgs["thinking-display"] = "summarized";
    }

    const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
      cwd,
      env: { ...process.env, ...CC_CHILD_ENV },
      tools: [], // Disable CLI built-in tools so execution goes through DSH
      permissionMode: "bypassPermissions",
      includePartialMessages: true,
      settings: {
        autoMemoryEnabled: config.autoMemoryEnabled,
      },
      systemPrompt: options.system
        ? { type: "preset", preset: "claude_code", append: options.system }
        : { type: "preset", preset: "claude_code" },
      extraArgs,
      ...(effort ? { effort } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(config.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable }
        : {}),
    };

    const prompt = currentPromptBlocks ? (currentPromptBlocks as any) : currentPrompt;
    const sdkQuery = query({ prompt, options: queryOptions });

    // Wire cancellation
    const onAbort = () => {
      void sdkQuery.interrupt().catch(() => {});
      try {
        sdkQuery.close();
      } catch {}
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      yield* translateSdkQuery(sdkQuery, options.signal, (capturedId) => {
        this.sessionManager.recordCapturedSessionId(
          options.sessionId,
          capturedId,
          cwd,
          options.messages.length,
        );
      });
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      try {
        sdkQuery.close();
      } catch {}
    }
  }
}
