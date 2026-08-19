import type {
  LlmModelInfo,
  LlmResolvedModelInfo,
  LlmReasoningEffortInfo,
} from "@deepseek-ai/dsh-llm";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { Config } from "./config.js";

export const TWO_HUNDRED_K_CONTEXT = 200_000;
export const ONE_M_CONTEXT = 1_000_000;

/**
 * Canonical display/selection order for the picker. The model list itself is
 * derived from pi-ai's anthropic catalog (getBuiltinModels) so names, context
 * windows, and metadata follow upstream instead of being duplicated here;
 * this array only pins the order the bridge exposes them in.
 *
 * Mirrors the approach in pi-claude-bridge's src/models.ts, which this package
 * is ported from.
 */
export const MODEL_IDS_IN_ORDER = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
];

let catalogCache: Map<string, PiAiModel> | null = null;

type PiAiModel = { id: string; name: string; reasoning?: boolean };

function anthropicCatalog(): Map<string, PiAiModel> {
  if (!catalogCache) {
    catalogCache = new Map(getBuiltinModels("anthropic").map((m) => [m.id, m]));
  }
  return catalogCache;
}

/**
 * Resolve the Claude Code CLI model id and context window for a DSH model id.
 *
 * This part is unavoidably hardcoded: it describes Claude Code CLI behavior
 * (the `[1m]` suffix and the 1M-vs-200K entitlement differ by model and by
 * plan tier), which pi-ai's catalog does not encode. pi-claude-bridge hardcodes
 * the same mapping in resolveClaudeCodeRuntimeModel for the same reason.
 */
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

function displayName(modelId: string, catalogName: string | undefined): string {
  return catalogName || modelId;
}

function reasoningFor(modelId: string): boolean {
  // pi-ai anthropic models are all reasoning-capable today; a model missing from
  // the catalog (unknown id) defaults to reasoning so nothing is silently capped.
  return true;
}

export function listClaudeBridgeModels(provider: string, config: Config): LlmModelInfo[] {
  const catalog = modelsOfPiAi();
  return MODEL_IDS_IN_ORDER
    .map((id) => catalog.get(id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) => {
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
  const catalog = modelsOfPiAi();
  const known = catalog.get(modelId);
  const name = displayName(modelId, known?.name);
  const reasoning = known?.reasoning ?? true;
  const suffix = contextWindow >= ONE_M_CONTEXT ? " (1M)" : "";

  return {
    provider,
    id: modelId,
    name: `${name}${suffix}`,
    description: `Claude Code subscription model (${contextWindow / 1000}k context)`,
    inputModalities: ["text", "image"],
    context: {
      contextWindow,
    },
    defaultMaxTokens: 64_000,
    ...(reasoning
      ? {
          reasoning: {
            efforts: REASONING_EFFORTS,
            defaultEffort: ReasoningEffortId("high"),
          },
        }
      : {}),
  };
}

function modelsOfPiAi(): Map<string, PiAiModel> {
  return anthropicCatalog();
}