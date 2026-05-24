import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildContextPayload } from "./context.js";
import { renderModelHandoffPrompt } from "./handoff.js";
import { splitModelID } from "./profiles.js";

const TURNS_FILE = ".opencode/local-code/turns.json";
const TURN_LOG_MAX = 50;
const HANDOFF_PREFIX = "[Local-code model handoff]";
const DIRECT_MODEL_RE = /^\/model\s+([^\s/]+\/[^\s]+)\s*$/;

const DEBUG = process.env.LOCAL_CODE_OPENCODE_DEBUG === "1";
const log = (...args) => DEBUG && console.error("[lc-plugin]", ...args);

async function loadTurns(root) {
  try {
    const raw = await readFile(path.join(root, TURNS_FILE), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return sanitizeTurns(parsed);
  } catch {}
  return [];
}

async function saveTurns(root, turns) {
  try {
    await mkdir(path.join(root, ".opencode/local-code"), { recursive: true });
    const payload = sanitizeTurns(turns);
    await writeFile(path.join(root, TURNS_FILE), JSON.stringify(payload, null, 2));
  } catch (err) {
    log("failed to save turns:", err?.message);
  }
}

function isLocalCodeHandoffText(text) {
  return typeof text === "string" && text.trimStart().startsWith(HANDOFF_PREFIX);
}

function sanitizeTurns(turns) {
  return turns.filter((turn) => !isLocalCodeHandoffText(turn?.request)).slice(-TURN_LOG_MAX);
}

function parseDirectModelCommand(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(DIRECT_MODEL_RE);
  return match?.[1] ?? null;
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
  const handledDirectModelMessages = new Set();
  let directModelOverride = null;
  let seenInitialModel = false;
  let switching = false;

  log("loaded", turns.length, "previous turns");

  async function injectContext(nextModel) {
    if (!sessionID) {
      log("no sessionID, skipping context injection");
      return;
    }
    if (switching) { log("already switching, skip"); return; }
    switching = true;
    try {
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
    } finally {
      switching = false;
    }
  }

  async function handleDirectModelCommand(messageID, text) {
    const nextModel = parseDirectModelCommand(text);
    if (!nextModel || handledDirectModelMessages.has(messageID)) return false;
    handledDirectModelMessages.add(messageID);

    if (pendingMessageID === messageID && turns.length > 0) {
      turns.pop();
      pendingMessageID = null;
      await saveTurns(root, turns);
    }

    log("direct /model command:", currentModel, "→", nextModel);
    directModelOverride = nextModel;
    await injectContext(nextModel);
    if (pendingMessageID === messageID && turns.length > 0) {
      turns.pop();
      pendingMessageID = null;
      await saveTurns(root, turns);
      log("ignored direct /model turn");
    }
    return true;
  }

  return {
    event: async ({ event }) => {
      const { type, properties } = event ?? {};
      if (!type) return;

      if (type === "session.created") {
        const id = properties?.info?.id;
        if (id) { sessionID = id; log("session created:", id); }
      }

      if (type === "session.next.model.switched") {
        const model = properties?.model;
        if (!model) return;
        const nextModel = modelStr(model);
        if (directModelOverride && nextModel !== directModelOverride) {
          log("ignored stale model switch:", nextModel, "while direct target is", directModelOverride);
          return;
        }
        if (directModelOverride === nextModel) directModelOverride = null;
        log("model switched:", currentModel, "→", nextModel);
        await injectContext(nextModel);
      }

      if (type === "session.updated") {
        const model = properties?.info?.model;
        if (!model) return;
        const nextModel = modelStr(model);
        if (!seenInitialModel) { currentModel = nextModel; seenInitialModel = true; return; }
        if (directModelOverride && nextModel !== directModelOverride) {
          log("ignored stale session model:", nextModel, "while direct target is", directModelOverride);
          return;
        }
        if (directModelOverride === nextModel) directModelOverride = null;
        if (nextModel !== currentModel) {
          log("model change in session.updated:", currentModel, "→", nextModel);
          await injectContext(nextModel);
        }
      }

      if (type === "session.next.agent.switched") {
        const agent = properties?.agent;
        if (agent) { currentAgent = agent; log("agent:", agent); }
      }

      if (type === "message.part.updated") {
        const part = properties?.part;
        if (!part) return;
        if (part.type === "text" && part.messageID) {
          partBuffer.set(part.messageID, part.text);
          if (await handleDirectModelCommand(part.messageID, part.text)) return;
          if (pendingMessageID === part.messageID && turns.length > 0) {
            if (isLocalCodeHandoffText(part.text)) {
              turns.pop();
              pendingMessageID = null;
              await saveTurns(root, turns);
              log("ignored injected handoff turn");
              return;
            }
            turns[turns.length - 1].request = part.text;
            saveTurns(root, turns).catch(() => {});
          }
        }
      }

      if (type === "message.updated") {
        if (properties?.sessionID) sessionID = properties.sessionID;
        const info = properties?.info;
        if (!info) return;
        const role = info.role ?? "";

        if (role === "user") {
          const request = partBuffer.get(info.id);
          if (handledDirectModelMessages.has(info.id)) {
            pendingMessageID = null;
            await saveTurns(root, turns);
            log("ignored direct /model turn");
            return;
          }
          if (await handleDirectModelCommand(info.id, request)) return;
          if (isLocalCodeHandoffText(request)) {
            pendingMessageID = null;
            await saveTurns(root, turns);
            log("ignored injected handoff turn");
            return;
          }
          if (directModelOverride) {
            log("cleared direct model override before normal turn:", directModelOverride);
            directModelOverride = null;
          }
          if (info.model) currentModel = modelStr(info.model, currentModel);
          if (info.agent) currentAgent = info.agent;
          if (info.summary?.diffs && turns.length > 0) {
            const last = turns[turns.length - 1];
            if (!last.diffStats.length) last.diffStats = extractDiffStats(info.summary.diffs);
          }
          turns.push({ model: currentModel, agent: currentAgent, request, diffStats: [], createdAt: new Date().toISOString() });
          pendingMessageID = info.id;
          if (turns.length > TURN_LOG_MAX) turns.splice(0, turns.length - TURN_LOG_MAX);
          await saveTurns(root, turns);
          log("turn #" + turns.length, "model:", currentModel);
        }

        if (role === "assistant" && info.modelID && info.providerID) {
          const assistantModel = `${info.providerID}/${info.modelID}`;
          if (directModelOverride && assistantModel !== directModelOverride) {
            log("ignored stale assistant model:", assistantModel, "while direct target is", directModelOverride);
            return;
          }
          currentModel = assistantModel;
          if (directModelOverride === assistantModel) directModelOverride = null;
        }
      }

      if (type === "session.idle") {
        if (properties?.sessionID) sessionID = properties.sessionID;
        if (turns.length > 0) { await saveTurns(root, turns); log("session idle, turns saved:", turns.length); }
      }
    },
  };
};

export default LocalCodeOpenCodePlugin;
export { splitModelID };
