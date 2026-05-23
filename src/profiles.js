export const DEFAULT_PROFILES = {
  sonnet: {
    model: "anthropic/claude-sonnet-4-5",
    agent: "build",
    description: "main implementation model",
  },
  qwen: {
    model: "openrouter/qwen/qwen3-coder",
    agent: "build",
    description: "cheap coding model",
  },
  kimi: {
    model: "openrouter/moonshotai/kimi-k2",
    agent: "build",
    description: "cheap long-context/debug model",
  },
  review: {
    model: "anthropic/claude-sonnet-4-5",
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
