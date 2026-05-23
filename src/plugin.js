import { buildContextPayload } from "./context.js";
import { renderModelHandoffPrompt } from "./handoff.js";
import { DEFAULT_PROFILES, resolveProfile, splitModelID } from "./profiles.js";

/**
 * Draft OpenCode plugin.
 *
 * The exact event payloads need a spike against a running OpenCode build.
 * This plugin is intentionally conservative: it logs payload shapes when
 * LOCAL_CODE_OPENCODE_DEBUG=1 and contains the target /lc-model flow.
 */
export const LocalCodeOpenCodePlugin = async ({ client, directory, project }) => {
  const root = directory ?? project?.path ?? process.cwd();
  let currentModel = "unknown";

  async function injectContext({ sessionID, nextModel }) {
    if (!sessionID) throw new Error("OpenCode session id is unavailable; run event payload spike first");
    const payload = await buildContextPayload({ cwd: root, previousModel: currentModel, nextModel });
    const text = renderModelHandoffPrompt(payload);
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text }],
      },
    });
    currentModel = nextModel;
    return text;
  }

  async function handleLocalModelCommand(input) {
    const command = input?.command ?? input?.body?.command ?? "";
    if (command !== "lc-model" && command !== "/lc-model") return;

    const rawArgs = input?.arguments ?? input?.body?.arguments ?? "";
    const profileName = String(rawArgs).trim() || "sonnet";
    const profile = resolveProfile(profileName, DEFAULT_PROFILES);
    const sessionID = input?.sessionID ?? input?.session?.id ?? input?.body?.sessionID;

    await injectContext({ sessionID, nextModel: profile.model });

    // Candidate: use config patch for persistent TUI model state.
    // This needs verification against OpenCode TUI state sync.
    if (client.config?.update) {
      await client.config.update({ body: { model: profile.model } });
    }

    if (client.tui?.showToast) {
      await client.tui.showToast({ body: { message: `local-code context injected; model => ${profileName}`, variant: "success" } });
    }
  }

  return {
    event: async ({ event }) => {
      if (process.env.LOCAL_CODE_OPENCODE_DEBUG === "1") {
        await safeLog(client, "debug", "opencode event", { type: event?.type, keys: Object.keys(event ?? {}) });
      }
    },
    "tui.command.execute": async (input) => {
      if (process.env.LOCAL_CODE_OPENCODE_DEBUG === "1") {
        await safeLog(client, "debug", "tui.command.execute", { keys: Object.keys(input ?? {}), input });
      }
      await handleLocalModelCommand(input);
    },
  };
};

export default LocalCodeOpenCodePlugin;
export { splitModelID };

async function safeLog(client, level, message, extra) {
  try {
    await client.app.log({ body: { service: "local-code-opencode-plugin", level, message, extra } });
  } catch {
    // Logging must never break the user's OpenCode session.
  }
}
