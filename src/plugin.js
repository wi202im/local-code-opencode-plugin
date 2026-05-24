import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildContextPayload } from "./context.js";
import { renderModelHandoffPrompt } from "./handoff.js";
import { splitModelID } from "./profiles.js";

const TURNS_FILE = ".opencode/local-code/turns.json";
const TURN_LOG_MAX = 50;

const DEBUG = process.env.LOCAL_CODE_OPENCODE_DEBUG === "1";
const log = (...args) => DEBUG && console.error("[lc-plugin]", ...args);

async function loadTurns(root) {
  try {
    const raw = await readFile(path.join(root, TURNS_FILE), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.slice(-TURN_LOG_MAX);
  } catch {}
  return [];
}

async function saveTurns(root, turns) {
  try {
    await mkdir(path.join(root, ".opencode/local-code"), { recursive: true });
    const payload = turns.slice(-TURN_LOG_MAX);
    await writeFile(path.join(root, TURNS_FILE), JSON.stringify(payload, null, 2));
  } catch (err) {
    log("failed to save turns:", err?.message);
  }
}

function modelStr(modelObj, fallback = "unknown") {
  if (!modelObj) return fallback;
  const pid = modelObj.providerID || "";
  const mid = modelObj.modelID || modelObj.id || "";
  return pid && mid ? `${pid}/${mid}` : fallback;
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

  let turns = await loadTurns(root);
  let pendingMessageID = null;
  const partBuffer = new Map();

  log("loaded", turns.length, "previous turns");

  async function injectContext(nextModel) {
    if (!sessionID) {
      log("no sessionID, skipping context injection");
      return;
    }
    const payload = await buildContextPayload({ cwd: root, previousModel: currentModel, nextModel });

    const hasRelevantChanges = payload.repoStates.some(
      (s) => s.status || s.diffStat
    );
    if (!payload.repos.length || !hasRelevantChanges) {
      if (!payload.repos.length) log("no repos found, skipping injection");
      else log("no changes detected, skipping injection");
      currentModel = nextModel;
      return;
    }

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

    "message.part.updated": (input) => {
      const part = input?.properties?.part;
      if (!part) return;
      if (part.type === "text" && part.messageID) {
        partBuffer.set(part.messageID, part.text);
        if (pendingMessageID === part.messageID && turns.length > 0) {
          turns[turns.length - 1].request = part.text;
          saveTurns(root, turns).catch(() => {});
        }
      }
    },

    "message.updated": async (input) => {
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
          request: partBuffer.get(info.id),
          diffStats: [],
          createdAt: new Date().toISOString(),
        });
        pendingMessageID = info.id;

        if (turns.length > TURN_LOG_MAX) {
          turns.splice(0, turns.length - TURN_LOG_MAX);
        }

        await saveTurns(root, turns);
        log("turn #" + turns.length, "model:", currentModel);
      }

      if (role === "assistant" && info.modelID && info.providerID) {
        currentModel = `${info.providerID}/${info.modelID}`;
      }
    },

    "session.idle": async (input) => {
      if (input?.properties?.sessionID) sessionID = input.properties.sessionID;

      if (turns.length > 0) {
        await saveTurns(root, turns);
        log("session idle, turns saved:", turns.length);
      }
    },
  };
};

export default LocalCodeOpenCodePlugin;
export { splitModelID };
