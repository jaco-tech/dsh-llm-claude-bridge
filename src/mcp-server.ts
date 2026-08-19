import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";

export const TOOL_USE_ID_META = "claudecode/toolUseId";

export interface McpResult {
  toolCallId: string;
  content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface BridgeToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (toolCallId: string, args: Record<string, unknown>) => Promise<McpResult>;
}

export function createMcpToolServer(serverName: string, tools: BridgeToolDef[]) {
  const server = new McpServer({ name: serverName, version: "1.0.0" }, { capabilities: { tools: {} } });
  const byName = new Map(tools.map((t) => [t.name, t]));

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    const toolCallId = (request.params._meta?.[TOOL_USE_ID_META] as string) || `call_${Date.now()}`;
    const args = (request.params.arguments as Record<string, unknown>) ?? {};
    const result = await tool.handler(toolCallId, args);
    return {
      content: typeof result.content === "string"
        ? [{ type: "text" as const, text: result.content }]
        : result.content.map((b) => {
            if (b.type === "image" && b.data && b.mimeType) {
              return {
                type: "image" as const,
                data: b.data,
                mimeType: b.mimeType,
              };
            }
            return { type: "text" as const, text: b.text ?? "" };
          }),
      isError: result.isError,
    };
  });

  return { type: "sdk" as const, name: serverName, instance: server };
}

export function toolsToBridgeDefs(
  tools: ToolSchema[] | undefined,
  onToolCall: (callId: string, name: string, args: Record<string, unknown>) => Promise<McpResult>,
): BridgeToolDef[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    inputSchema: (t.parameters as Record<string, unknown>) || { type: "object", properties: {} },
    handler: (callId, args) => onToolCall(callId, t.name, args),
  }));
}
