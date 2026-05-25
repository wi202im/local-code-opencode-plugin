import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildContextPayload, collectDiffSnapshot, diffStatsBetweenSnapshots } from "./context.js";
import { renderModelHandoffPrompt } from "./handoff.js";
import { splitModelID } from "./profiles.js";

const TURNS_FILE = ".opencode/local-code/turns.json";
const TURN_LOG_MAX = 50;
const HANDOFF_PREFIX = "[Local-code model handoff]";
const INTERNAL_DIFF_PATH_PREFIX = ".opencode/local-code/";
const DIRECT_MODEL_RE = /^\/model\s+([^\s/]+\/[^\s]+)\s*$/;
const saveQueues = new Map();

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
  const previous = saveQueues.get(root) ?? Promise.resolve();
  const next = previous.then(async () => {
    await mkdir(path.join(root, ".opencode/local-code"), { recursive: true });
    const payload = sanitizeTurns(turns);
    const existing = await loadTurns(root);
    const merged = mergeTurns(existing, payload);
    await writeFile(path.join(root, TURNS_FILE), JSON.stringify(merged, null, 2));
  });
  saveQueues.set(root, next.catch(() => {}));
  try {
    await next;
  } catch (err) {
    log("failed to save turns:", err?.message);
  } finally {
    if (saveQueues.get(root) === next) saveQueues.delete(root);
  }
}

function isLocalCodeHandoffText(text) {
  return typeof text === "string" && text.trimStart().startsWith(HANDOFF_PREFIX);
}

function sanitizeTurns(turns) {
  return turns
    .filter((turn) => !isLocalCodeHandoffText(turn?.request))
    .filter((turn) => !parseDirectModelCommand(turn?.request))
    .filter((turn) => turn?.request || turn?.diffStats?.length)
    .slice(-TURN_LOG_MAX);
}

function turnIdentity(turn) {
  if (turn?.messageID) return `message:${turn.messageID}`;
  return `content:${turn?.createdAt ?? ""}:${turn?.model ?? ""}:${turn?.request ?? ""}`;
}

function mergeTurns(existing, incoming) {
  const merged = [];
  const indexes = new Map();
  for (const turn of [...sanitizeTurns(existing), ...sanitizeTurns(incoming)]) {
    const key = turnIdentity(turn);
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, merged.length);
      merged.push(turn);
      continue;
    }
    const current = merged[index];
    merged[index] = {
      ...current,
      ...turn,
      request: turn.request || current.request,
      diffStats: turn.diffStats?.length ? turn.diffStats : current.diffStats,
    };
  }
  return sanitizeTurns(merged).slice(-TURN_LOG_MAX);
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

function isStaleDirectModelEvent(override, model) {
  return Boolean(override && model === override.previous && model !== override.target);
}

function extractDiffStats(summaryDiffs) {
  if (!Array.isArray(summaryDiffs) || !summaryDiffs.length) return [];
  const seen = new Set();
  const stats = [];
  for (const entry of summaryDiffs) {
    const file = entry?.file;
    if (isInternalDiffPath(file)) continue;
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const patchLen = typeof entry?.patch === "string" ? entry.patch.length : 0;
    stats.push({ name: file.split("/").pop() || file, path: file, diffStat: `${patchLen} bytes changed` });
  }
  return stats;
}

function extractTextPart(parts) {
  if (!Array.isArray(parts)) return undefined;
  return parts.find((part) => part?.type === "text" && typeof part.text === "string")?.text;
}

function promptHistoryPath() {
  const stateHome = process.env.XDG_STATE_HOME;
  if (!stateHome) return null;
  return path.join(stateHome, "opencode/prompt-history.jsonl");
}

async function readPromptHistory() {
  const historyPath = promptHistoryPath();
  if (!historyPath) return [];
  try {
    const raw = await readFile(historyPath, "utf-8");
    return raw.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function latestPromptHistoryInputSince(cursor) {
  const lines = await readPromptHistory();
  const nextCursor = lines.length;
  const inputs = lines.slice(cursor).map((line) => {
    try { return JSON.parse(line)?.input; } catch { return undefined; }
  }).filter((input) => typeof input === "string" && input.trim());
  return { input: inputs.at(-1), cursor: nextCursor };
}

function isInternalDiffPath(file) {
  return typeof file === "string" && (file === ".opencode/local-code" || file.startsWith(INTERNAL_DIFF_PATH_PREFIX));
}

export const LocalCodeOpenCodePlugin = async ({ client, directory, project }) => {
  const root = directory ?? project?.path ?? process.cwd();
  let sessionID = null;
  let currentModel = "unknown";
  let currentAgent = "build";

  let turns = await loadTurns(root);
  const lastTurn = turns.at(-1);
  if (lastTurn?.model) currentModel = lastTurn.model;
  if (lastTurn?.agent) currentAgent = lastTurn.agent;
  let pendingMessageID = null;
  let pendingDiffSnapshot = null;
  let pendingTurnDraft = null;
  const deferredTurnDrafts = new Map();
  const partBuffer = new Map();
  const handledDirectModelMessages = new Set();
  const finalizedUserMessages = new Set();
  let directModelOverride = null;
  let seenInitialModel = false;
  let switching = false;
  let promptHistoryCursor = (await readPromptHistory()).length;

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

  async function finalizePendingTurn() {
    if (!pendingMessageID || !pendingDiffSnapshot) return;
    const messageID = pendingMessageID;
    const turn = turns.findLast((entry) => entry.messageID === messageID);
    if (!turn) {
      if (pendingTurnDraft) {
        deferredTurnDrafts.set(messageID, { draft: pendingTurnDraft, diffSnapshot: pendingDiffSnapshot });
      } else {
        finalizedUserMessages.add(messageID);
      }
      pendingMessageID = null;
      pendingDiffSnapshot = null;
      pendingTurnDraft = null;
      await saveTurns(root, turns);
      return;
    }
    const after = await collectDiffSnapshot({ cwd: root });
    const diffStats = diffStatsBetweenSnapshots(pendingDiffSnapshot, after);
    if (diffStats.length) turn.diffStats = diffStats;
    if (!turn.request && !turn.diffStats.length) turns.pop();
    finalizedUserMessages.add(messageID);
    pendingMessageID = null;
    pendingDiffSnapshot = null;
    pendingTurnDraft = null;
    await saveTurns(root, turns);
    log("finalized turn diff stats:", diffStats.length);
  }

  async function materializePendingTurn(request, messageID = pendingMessageID) {
    const deferred = deferredTurnDrafts.get(messageID);
    const draft = pendingTurnDraft?.messageID === messageID ? pendingTurnDraft : deferred?.draft;
    if (!draft) return turns.findLast((entry) => entry.messageID === messageID) ?? turns.at(-1);
    const existing = turns.find((entry) => entry.messageID === draft.messageID);
    if (existing) return existing;
    const turn = { ...draft, request };
    turns.push(turn);
    if (pendingTurnDraft?.messageID === messageID) pendingTurnDraft = null;
    deferredTurnDrafts.delete(messageID);
    if (turns.length > TURN_LOG_MAX) turns.splice(0, turns.length - TURN_LOG_MAX);
    return turn;
  }

  function requestTextForMessage(info, properties) {
    return partBuffer.get(info.id)
      ?? extractTextPart(info.parts)
      ?? extractTextPart(properties?.parts)
      ?? extractTextPart(properties?.message?.parts);
  }

  async function recoverDeferredTurnFromPromptHistory() {
    if (!deferredTurnDrafts.size) return false;
    const recovered = await latestPromptHistoryInputSince(promptHistoryCursor);
    promptHistoryCursor = recovered.cursor;
    const request = recovered.input;
    if (!request || isLocalCodeHandoffText(request) || parseDirectModelCommand(request)) return false;
    const messageID = [...deferredTurnDrafts.keys()].at(-1);
    const turn = await materializePendingTurn(request, messageID);
    turn.request = request;
    await saveTurns(root, turns);
    log("recovered pending turn from prompt history:", messageID);
    return true;
  }

  async function handleDirectModelCommand(messageID, text) {
    const nextModel = parseDirectModelCommand(text);
    if (!nextModel || handledDirectModelMessages.has(messageID)) return false;
    handledDirectModelMessages.add(messageID);

    if (pendingMessageID === messageID && turns.at(-1)?.messageID === messageID) {
      turns.pop();
      pendingMessageID = null;
      pendingDiffSnapshot = null;
      pendingTurnDraft = null;
      deferredTurnDrafts.delete(messageID);
      await saveTurns(root, turns);
    } else {
      await finalizePendingTurn();
      deferredTurnDrafts.delete(messageID);
    }

    log("direct /model command:", currentModel, "→", nextModel);
    directModelOverride = { previous: currentModel, target: nextModel };
    await injectContext(nextModel);
    if (pendingMessageID === messageID && turns.at(-1)?.messageID === messageID) {
      turns.pop();
      pendingMessageID = null;
      pendingDiffSnapshot = null;
      pendingTurnDraft = null;
      deferredTurnDrafts.delete(messageID);
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
        if (properties?.sessionID) sessionID = properties.sessionID;
        const model = properties?.model;
        if (!model) return;
        const nextModel = modelStr(model);
        if (isStaleDirectModelEvent(directModelOverride, nextModel)) {
          log("ignored stale model switch:", nextModel, "while direct target is", directModelOverride.target);
          return;
        }
        if (directModelOverride && nextModel !== directModelOverride.previous) directModelOverride = null;
        log("model switched:", currentModel, "→", nextModel);
        await injectContext(nextModel);
      }

      if (type === "session.updated") {
        const model = properties?.info?.model;
        if (!model) return;
        const nextModel = modelStr(model);
        if (!seenInitialModel) { currentModel = nextModel; seenInitialModel = true; return; }
        if (isStaleDirectModelEvent(directModelOverride, nextModel)) {
          log("ignored stale session model:", nextModel, "while direct target is", directModelOverride.target);
          return;
        }
        if (directModelOverride && nextModel !== directModelOverride.previous) directModelOverride = null;
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
          if (pendingMessageID === part.messageID || deferredTurnDrafts.has(part.messageID)) {
            if (isLocalCodeHandoffText(part.text)) {
              const last = turns.at(-1);
              if (last?.messageID === part.messageID && (!last.request || isLocalCodeHandoffText(last.request))) {
                turns.pop();
              }
              if (pendingMessageID === part.messageID) {
                pendingMessageID = null;
                pendingDiffSnapshot = null;
                pendingTurnDraft = null;
              }
              deferredTurnDrafts.delete(part.messageID);
              await saveTurns(root, turns);
              log("ignored injected handoff turn");
              return;
            }
            const turn = await materializePendingTurn(part.text, part.messageID);
            turn.request = part.text;
            await saveTurns(root, turns);
            log("updated pending turn:", part.messageID);
          }
        }
      }

      if (type === "message.updated") {
        if (properties?.sessionID) sessionID = properties.sessionID;
        const info = properties?.info;
        if (!info) return;
        const role = info.role ?? "";

        if (role === "user") {
          const request = requestTextForMessage(info, properties);
          if (handledDirectModelMessages.has(info.id)) {
            pendingMessageID = null;
            pendingDiffSnapshot = null;
            pendingTurnDraft = null;
            deferredTurnDrafts.delete(info.id);
            await saveTurns(root, turns);
            log("ignored direct /model turn");
            return;
          }
          if (await handleDirectModelCommand(info.id, request)) return;
          if (isLocalCodeHandoffText(request)) {
            pendingMessageID = null;
            pendingDiffSnapshot = null;
            pendingTurnDraft = null;
            deferredTurnDrafts.delete(info.id);
            await saveTurns(root, turns);
            log("ignored injected handoff turn");
            return;
          }
          if (directModelOverride && request) {
            log("cleared direct model override before normal turn:", directModelOverride.target);
            directModelOverride = null;
          }
          if (finalizedUserMessages.has(info.id)) {
            log("ignored finalized user message:", info.id);
            return;
          }
          if (deferredTurnDrafts.has(info.id)) {
            if (request && !isLocalCodeHandoffText(request)) {
              const turn = await materializePendingTurn(request, info.id);
              turn.request = request;
              await saveTurns(root, turns);
              log("updated pending turn:", info.id);
            }
            return;
          }
          if (pendingMessageID === info.id) {
            const last = turns.findLast((entry) => entry.messageID === info.id);
            if (!last) {
              if (request && !isLocalCodeHandoffText(request)) {
                const turn = await materializePendingTurn(request, info.id);
                turn.request = request;
                await saveTurns(root, turns);
                log("updated pending turn:", info.id);
              }
              return;
            }
            if (request && !isLocalCodeHandoffText(request)) last.request = request;
            const fallbackDiffStats = extractDiffStats(info.summary?.diffs);
            if (!last.diffStats.length && fallbackDiffStats.length) last.diffStats = fallbackDiffStats;
            await saveTurns(root, turns);
            log("updated pending turn:", info.id);
            return;
          }
          await finalizePendingTurn();
          if (info.model) currentModel = modelStr(info.model, currentModel);
          if (info.agent) currentAgent = info.agent;
          const initialDiffStats = extractDiffStats(info.summary?.diffs);
          const before = await collectDiffSnapshot({ cwd: root });
          const draft = { messageID: info.id, model: currentModel, agent: currentAgent, request, diffStats: initialDiffStats, createdAt: new Date().toISOString() };
          pendingMessageID = info.id;
          pendingDiffSnapshot = before;
          if (!request && !initialDiffStats.length) {
            pendingTurnDraft = draft;
            log("pending user message:", info.id);
            return;
          }
          pendingTurnDraft = null;
          turns.push(draft);
          if (turns.length > TURN_LOG_MAX) turns.splice(0, turns.length - TURN_LOG_MAX);
          await saveTurns(root, turns);
          log("turn #" + turns.length, "model:", currentModel);
        }

        if (role === "assistant" && info.modelID && info.providerID) {
          const assistantModel = `${info.providerID}/${info.modelID}`;
          if (isStaleDirectModelEvent(directModelOverride, assistantModel)) {
            log("ignored stale assistant model:", assistantModel, "while direct target is", directModelOverride.target);
            return;
          }
          currentModel = assistantModel;
          if (directModelOverride && assistantModel !== directModelOverride.previous) directModelOverride = null;
        }
      }

      if (type === "session.idle") {
        if (properties?.sessionID) sessionID = properties.sessionID;
        await finalizePendingTurn();
        await recoverDeferredTurnFromPromptHistory();
        if (turns.length > 0) { await saveTurns(root, turns); log("session idle, turns saved:", turns.length); }
      }
    },
  };
};

export default LocalCodeOpenCodePlugin;
export { splitModelID };
