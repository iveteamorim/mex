import { claudeAdapter } from "./claude.mjs";
import { codexAdapter } from "./codex.mjs";

const ADAPTERS = { claude: claudeAdapter, codex: codexAdapter };

export function getAgentAdapter(id) {
  const adapter = ADAPTERS[id];
  if (!adapter) throw new Error(`unknown headless agent adapter ${id}; expected ${Object.keys(ADAPTERS).join(" or ")}`);
  return adapter;
}

export function agentAdapterIds() {
  return Object.keys(ADAPTERS);
}
