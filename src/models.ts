import type {
  LlmModelInfo,
  LlmResolvedModelInfo,
  LlmReasoningEffortInfo,
} from "@deepseek-ai/dsh-llm";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { Config } from "./config.js";

export const TWO_HUNDRED_K_CONTEXT = 200_000;
export const ONE_M_CONTEXT = 1_000_000;

export const KNOWN_MODELS: Array<{
  id: string;
  name: string;
  description?: string;
  reasoning: boolean;
}> = [
  { id: "claude-opus-5", name: "Claude Opus 5", reasoning: true },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", reasoning: true },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true },
  { id: "claude-fable-5", name: "Claude Fable 5", reasoning: true },
];

export function resolveContextWindow(modelId: string, config: Config): { cliModelId: string; contextWindow: number } {
  switch (modelId) {
    case "claude-opus-5":
      return { cliModelId: "claude-opus-5[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-opus-4-8":
      return { cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-opus-4-7":
      return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
    case "claude-opus-4-6": {
      const useOneM = config.plan === "max" || config.longContextExtraUsage;
      return {
        cliModelId: useOneM ? "claude-opus-4-6[1m]" : "claude-opus-4-6",
        contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
      };
    }
    case "claude-fable-5":
      return { cliModelId: "claude-fable-5[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-sonnet-5":
      return { cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-sonnet-4-6":
      return {
        cliModelId: config.longContextExtraUsage ? "claude-sonnet-4-6[1m]" : "claude-sonnet-4-6",
        contextWindow: config.longContextExtraUsage ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
      };
    case "claude-sonnet-4-5":
      return { cliModelId: "claude-sonnet-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
    case "claude-haiku-4-5":
      return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
    default:
      return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
  }
}

export const REASONING_EFFORTS: LlmReasoningEffortInfo[] = [
  { id: ReasoningEffortId("off"), name: "Off", description: "Standard generation with no extended thinking" },
  { id: ReasoningEffortId("low"), name: "Low", description: "Minimal extended thinking effort" },
  { id: ReasoningEffortId("medium"), name: "Medium", description: "Balanced extended thinking" },
  { id: ReasoningEffortId("high"), name: "High", description: "Thorough extended thinking" },
  { id: ReasoningEffortId("xhigh"), name: "Extra High", description: "Deep extended thinking" },
  { id: ReasoningEffortId("max"), name: "Maximum", description: "Maximum extended thinking capability" },
];

export function listClaudeBridgeModels(provider: string, config: Config): LlmModelInfo[] {
  return KNOWN_MODELS.map((m) => {
    const { contextWindow } = resolveContextWindow(m.id, config);
    const suffix = contextWindow >= ONE_M_CONTEXT ? " (1M)" : "";
    return {
      provider,
      id: m.id,
      name: `${m.name}${suffix}`,
      description: `Claude Code subscription model (${contextWindow / 1000}k context)`,
      inputModalities: ["text", "image"],
    };
  });
}

export function resolveClaudeBridgeModelInfo(
  provider: string,
  modelId: string,
  config: Config,
): LlmResolvedModelInfo {
  const { cliModelId, contextWindow } = resolveContextWindow(modelId, config);
  const known = KNOWN_MODELS.find((m) => m.id === modelId) ?? {
    id: modelId,
    name: modelId,
    reasoning: true,
  };
  const suffix = contextWindow >= ONE_M_CONTEXT ? " (1M)" : "";

  return {
    provider,
    id: modelId,
    name: `${known.name}${suffix}`,
    description: `Claude Code subscription model (${contextWindow / 1000}k context)`,
    inputModalities: ["text", "image"],
    context: {
      contextWindow,
    },
    defaultMaxTokens: 64_000,
    ...(known.reasoning
      ? {
          reasoning: {
            efforts: REASONING_EFFORTS,
            defaultEffort: ReasoningEffortId("high"),
          },
        }
      : {}),
  };
}
