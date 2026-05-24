import { buildContextPayload } from "./context.js";
import { renderModelHandoffPrompt } from "./handoff.js";
import { DEFAULT_PROFILES, resolveProfile, splitModelID } from "./profiles.js";

const TURN_LOG_MAX = 50;

const DEBUG = process.env.LOCAL_CODE_OPENCODE_DEBUG === "1";
const log = (...args) => DEBUG && console.error("[lc-plugin]", ...args);

function modelStr(modelObj, fallback) {
  if (!modelObj) return fallback || "unknown";
  const pid = modelObj.providerID || "";
  const mid = modelObj.modelID || modelObj.id || "";
  return pid && mid ? `${pid}/${mid}` : fallback || "unknown";
}

function extractDiffStats(summaryDiffs) {
  if (!Array.isArray(summaryDiffs) || !summaryDiffs.length) return [];
  const seen = new Set();
  const stats = [];
  for (const entry of summaryDiffs) {
    const file = entry?.file;
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const patchLen = typeof entry?.patch === "string" ? entry.patch.length : 0;
    stats.push({ name: file.split("/").pop() || file, path: file, diffStat: `${patchLen} bytes changed` });
  }
  return stats;
}

export const LocalCodeOpenCodePlugin = async ({ client, directory, project }) => {
  const root = directory ?? project?.path ?? process.cwd();
  let sessionID = null;
  let currentModel = "unknown";
  let currentAgent = "build";

  const turns = [];

  async function injectContext(nextModel) {
    if (!sessionID) {
      log("no sessionID, skipping context injection");
      return;
    }
    const payload = await buildContextPayload({ cwd: root, previousModel: currentModel, nextModel });
    if (turns.length) payload.turnLog = turns;

    const text = renderModelHandoffPrompt(payload);
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: { noReply: true, parts: [{ type: "text", text }] },
      });
      log("context injected, turns:", turns.length, "model:", nextModel);
    } catch (err) {
      log("context injection failed:", err?.message);
    }
    currentModel = nextModel;
  }

  return {
    "session.created": (input) => {
      const id = input?.properties?.info?.id;
      if (id) { sessionID = id; log("session created:", id); }
    },

    "session.next.model.switched": async (input) => {
      const model = input?.properties?.model;
      if (!model) return;
      const nextModel = modelStr(model);
      log("native model switch:", nextModel);
      await injectContext(nextModel);
    },

    "session.next.agent.switched": (input) => {
      const agent = input?.properties?.agent;
      if (agent) { currentAgent = agent; log("agent:", agent); }
    },

    "command.executed": async (input) => {
      const props = input?.properties ?? {};
      const name = props.name ?? "";
      const sid = props.sessionID;
      if (sid) sessionID = sid;
      if (!name.startsWith("lc-")) return;

      const profileName = name.slice(3);
      log("custom command:", name);

      try {
        const profile = resolveProfile(profileName, DEFAULT_PROFILES);
        await injectContext(profile.model);
      } catch (err) {
        log("unknown profile:", profileName, err?.message);
      }
    },

    "message.updated": (input) => {
      const props = input?.properties;
      if (!props) return;
      const info = props.info;
      if (!info) return;
      if (props.sessionID) sessionID = props.sessionID;

      const role = info.role ?? "";

      if (role === "user") {
        if (info.model) currentModel = modelStr(info.model, currentModel);
        if (info.agent) currentAgent = info.agent;

        if (info.summary?.diffs && turns.length > 0) {
          const last = turns[turns.length - 1];
          if (!last.diffStats.length) {
            last.diffStats = extractDiffStats(info.summary.diffs);
          }
        }

        turns.push({
          model: currentModel,
          agent: currentAgent,
          diffStats: [],
          createdAt: new Date().toISOString(),
        });

        if (turns.length > TURN_LOG_MAX) {
          turns.splice(0, turns.length - TURN_LOG_MAX);
        }

        log("turn #" + turns.length, "model:", currentModel);
      }

      if (role === "assistant" && info.modelID && info.providerID) {
        currentModel = `${info.providerID}/${info.modelID}`;
      }
    },

    "session.idle": (input) => {
      if (input?.properties?.sessionID) sessionID = input.properties.sessionID;
      log("session idle, turns:", turns.length);
    },
  };
};

export default LocalCodeOpenCodePlugin;
export { splitModelID };
