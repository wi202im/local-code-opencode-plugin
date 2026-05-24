export const DEFAULT_PROFILES = {
  codex: {
    model: "openai/gpt-5.3-codex",
    agent: "build",
    description: "primary coding model",
  },
  gpt55: {
    model: "openai/gpt-5.5-pro",
    agent: "build",
    description: "highest quality model",
  },
  deepseek: {
    model: "opencode-go/deepseek-v4-pro",
    agent: "build",
    description: "cheap general model",
  },
  qwen: {
    model: "opencode-go/qwen3.6-plus",
    agent: "build",
    description: "cheap coding model",
  },
  kimi: {
    model: "opencode-go/kimi-k2.6",
    agent: "build",
    description: "long-context model",
  },
  review: {
    model: "opencode-go/deepseek-v4-pro",
    agent: "plan",
    description: "read-only review mode",
  },
};

export function resolveProfile(name, profiles = DEFAULT_PROFILES) {
  const profile = profiles[name];
  if (!profile) {
    const available = Object.keys(profiles).join(", ");
    throw new Error(`unknown local-code OpenCode profile: ${name}. Available: ${available}`);
  }
  return profile;
}

export function splitModelID(model) {
  const slash = model.indexOf("/");
  if (slash === -1) return { providerID: "", modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}
