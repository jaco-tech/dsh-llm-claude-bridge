import type { Context } from "@deepseek-ai/cordis";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { Config } from "./config.js";
import { ClaudeBridgeAdapter } from "./adapter.js";

export const name = "llm-claude-bridge";
export const inject = ["llm"];

const NS = settingsNamespace("llm-claude-bridge");
export const PROVIDER_ID = "claude-bridge";

export function apply(ctx: Context, config: Config): void {
  let current = () => config;

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {
      ctx.logger.info("llm-claude-bridge: settings updated");
    },
  });

  const adapter = new ClaudeBridgeAdapter(() => current());

  // Register adapter with the LLM service
  ctx.llm.registerAdapter([PROVIDER_ID], adapter);

  // Register with directory for model discovery and UI selectors
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER_ID,
      displayName: "Claude Code Subscription (Bridge)",
      settingsNs: "llm-claude-bridge",
      settingsPath: [],
    },
  ]);

  ctx.logger.info("llm-claude-bridge: registered provider route 'claude-bridge'");
}

export { Config, ClaudeBridgeAdapter };
