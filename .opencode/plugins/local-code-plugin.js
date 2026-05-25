import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const execFileAsync = execFileSync;
const TURNS_FILE = ".opencode/local-code/turns.json";
const TURN_LOG_MAX = 50;
const HANDOFF_PREFIX = "[Local-code model handoff]";
const DIRECT_MODEL_RE = /^\/model\s+([^\s/]+\/[^\s]+)\s*$/;
const DEFAULT_HEAD_KEEP = 3;
const DEFAULT_TAIL_KEEP = 7;
const INTERNAL_DIFF_PATH_PREFIX = ".opencode/local-code/";
const HASH_OBJECT_CHUNK_SIZE = 100;
const malformedTurnsBackups = new Set();

const DEBUG = process.env.LOCAL_CODE_OPENCODE_DEBUG === "1";
const log = (...args) => DEBUG && console.error("[lc-plugin]", ...args);

// ── context (sync) ──

function buildContextPayload({ cwd = process.cwd(), previousModel = "unknown", nextModel = "unknown", logLimit = 10 } = {}) {
  const workspaceRoot = path.resolve(cwd);
  const repos = detectWorkspaceRepos(workspaceRoot);
  const repoStates = repos.map((repo) => collectRepoState(repo, { logLimit }));
  return { kind: "local-code-opencode-model-handoff", generatedAt: new Date().toISOString(), workspaceRoot, previousModel, nextModel, repos, repoStates, turnLog: [] };
}

function collectDiffSnapshot({ cwd = process.cwd() } = {}) {
  const workspaceRoot = path.resolve(cwd);
  const repos = detectWorkspaceRepos(workspaceRoot).map((repo) => collectRepoDiffSnapshot(repo));
  return { workspaceRoot, repos };
}

function diffStatsBetweenSnapshots(before, after) {
  const beforeRepos = new Map((before?.repos ?? []).map((repo) => [repo.repo.path, repo]));
  const afterRepos = new Map((after?.repos ?? []).map((repo) => [repo.repo.path, repo]));
  const multiRepo = new Set([...beforeRepos.keys(), ...afterRepos.keys()]).size > 1;
  const stats = [];

  for (const [repoPath, afterRepo] of afterRepos) {
    const beforeRepo = beforeRepos.get(repoPath);
    for (const [file, afterFile] of Object.entries(afterRepo.files ?? {})) {
      const beforeFile = beforeRepo?.files?.[file];
      if (beforeFile?.signature === afterFile.signature) continue;
      stats.push(formatSnapshotFile(afterRepo.repo, file, afterFile.diffStat, multiRepo));
    }
  }

  for (const [repoPath, beforeRepo] of beforeRepos) {
    const afterRepo = afterRepos.get(repoPath);
    for (const file of Object.keys(beforeRepo.files ?? {})) {
      if (afterRepo?.files?.[file]) continue;
      stats.push(formatSnapshotFile(beforeRepo.repo, file, "(reverted to clean during turn)", multiRepo));
    }
  }

  return stats;
}

function detectWorkspaceRepos(root) {
  const childRepos = [];
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (hasDotGit(full)) childRepos.push({ name: entry.name, path: full });
  }
  if (childRepos.length >= 2) return childRepos.sort((a, b) => a.name.localeCompare(b.name));
  if (isGitRepo(root)) return [{ name: path.basename(root) || ".", path: root }];
  if (childRepos.length === 1) return childRepos;
  return [];
}

function collectRepoState(repo, { logLimit = 10 } = {}) {
  return {
    repo,
    status: git(repo.path, ["status", "--short", "--", ".", ":(exclude).opencode/local-code/**"]),
    diffStat: git(repo.path, ["diff", "--stat", "--", ".", ":(exclude).opencode/local-code/**"]),
    log: git(repo.path, ["log", `-${logLimit}`, "--oneline"]),
  };
}

function collectRepoDiffSnapshot(repo) {
  const numstat = git(repo.path, ["diff", "HEAD", "--numstat"]);
  const nameStatus = git(repo.path, ["diff", "HEAD", "--name-status"]);
  const untracked = git(repo.path, ["ls-files", "--others", "--exclude-standard"]);
  const signatures = new Map();
  const diffStats = new Map();

  for (const line of numstat.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const file = parts.at(-1);
    if (file && !isInternalDiffPath(file)) {
      signatures.set(file, line);
      diffStats.set(file, formatNumstatLine(file, parts));
    }
  }

  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const file = parts.at(-1);
    if (file && !isInternalDiffPath(file)) signatures.set(file, `${signatures.get(file) ?? ""}|${line}`);
  }

  const untrackedFiles = untracked.split("\n").filter((file) => file && !isInternalDiffPath(file));
  const untrackedHashes = hashFiles(repo.path, untrackedFiles);
  for (const file of untrackedFiles) {
    const hash = untrackedHashes.get(file) ?? "";
    signatures.set(file, `untracked:${file}:${hash}`);
    diffStats.set(file, "(untracked file)");
  }

  const files = {};
  for (const [file, signature] of signatures) {
    files[file] = {
      signature,
      diffStat: diffStats.get(file) ?? "(changed)",
    };
  }
  return { repo, files };
}

function formatNumstatLine(file, parts) {
  const [added, deleted] = parts;
  if (!added || !deleted) return file;
  if (added === "-" || deleted === "-") return `${file} | binary changed`;
  const addedCount = Number(added);
  const deletedCount = Number(deleted);
  const total = addedCount + deletedCount;
  const markers = `${"+".repeat(Math.min(addedCount, 20))}${"-".repeat(Math.min(deletedCount, 20))}`;
  return `${file} | ${total} ${markers} (+${added} -${deleted})`;
}

function hashFiles(cwd, files) {
  if (!files.length) return new Map();
  const entries = [];
  for (let index = 0; index < files.length; index += HASH_OBJECT_CHUNK_SIZE) {
    const chunk = files.slice(index, index + HASH_OBJECT_CHUNK_SIZE);
    const output = git(cwd, ["hash-object", "--", ...chunk]);
    const hashes = output.split("\n").filter(Boolean);
    entries.push(...chunk.map((file, chunkIndex) => [file, hashes[chunkIndex] ?? ""]));
  }
  return new Map(entries);
}

function formatSnapshotFile(repo, file, diffStat, multiRepo) {
  const renderedPath = multiRepo ? `${repo.name}/${file}` : file;
  return {
    name: path.basename(file) || file,
    path: renderedPath,
    diffStat: diffStat || "(no changes)",
  };
}

function isInternalDiffPath(file) {
  return typeof file === "string" && (file === ".opencode/local-code" || file.startsWith(INTERNAL_DIFF_PATH_PREFIX));
}

function hasDotGit(dir) {
  try { const s = statSync(path.join(dir, ".git")); return s.isDirectory() || s.isFile(); } catch { return false; }
}

function isGitRepo(dir) {
  if (hasDotGit(dir)) return true;
  const result = git(dir, ["rev-parse", "--show-toplevel"], { silent: true });
  return path.resolve(result.trim()) === path.resolve(dir);
}

function git(cwd, args, { silent = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, maxBuffer: 1024 * 1024, encoding: "utf-8" }).trim();
  } catch (err) {
    if (!silent) log("git failed:", args.join(" "), err?.message);
    return "";
  }
}

// ── handoff ──

function renderModelHandoffPrompt(payload, options = {}) {
  const headKeep = options.headKeep ?? DEFAULT_HEAD_KEEP;
  const tailKeep = options.tailKeep ?? DEFAULT_TAIL_KEEP;
  const turnLog = payload.turnLog ?? [];
  const { headerLabel, workUnitsBlock } = formatWorkUnits(turnLog, { headKeep, tailKeep });
  return [
    "[Local-code model handoff]", "",
    "This is background context for a model handoff. Do not answer this handoff message directly.",
    "When the next user message arrives, follow that user message first. If it conflicts with this handoff, the user message wins.",
    "",
    `Previous model: ${payload.previousModel ?? "unknown"}`,
    `Next model: ${payload.nextModel ?? "unknown"}`,
    "",
    "Use the current git state and work units only when they are relevant.",
    "Do not push, merge, deploy, publish, or release without explicit user approval.",
    "", headerLabel, workUnitsBlock, "",
    "Registered repos:",
    ...(payload.repos ?? []).map((repo) => `- ${repo.name}: ${repo.path}`),
    "",
    ...renderRepoStates(payload.repoStates ?? []),
  ].join("\n").trimEnd();
}

function formatWorkUnits(turnLog, { headKeep, tailKeep }) {
  if (!turnLog.length) return { headerLabel: "Work units:", workUnitsBlock: "(none - continue from the current git state)" };
  const threshold = headKeep + tailKeep;
  if (turnLog.length <= threshold) return { headerLabel: `Work units (${turnLog.length} total):`, workUnitsBlock: renderTurns(turnLog, 1) };
  const headTurns = turnLog.slice(0, headKeep);
  const tailTurns = turnLog.slice(-tailKeep);
  const skipped = turnLog.length - headKeep - tailKeep;
  return {
    headerLabel: `Work units (${turnLog.length} total, first ${headKeep} + latest ${tailKeep}):`,
    workUnitsBlock: [renderTurns(headTurns, 1), `    ... (${skipped} middle turns omitted - use git diff/status below for accumulated changes) ...`, renderTurns(tailTurns, turnLog.length - tailKeep + 1)].join("\n"),
  };
}

function renderTurns(turns, startIndex) {
  return turns.map((turn, index) => {
    const lines = [`${startIndex + index}. (${turn.model ?? turn.agent ?? "?"}) ${turn.request ?? "(unknown request)"}`];
    if (Array.isArray(turn.diffStats) && turn.diffStats.length) {
      for (const entry of turn.diffStats) {
        lines.push(`    [${entry.name}] ${entry.path}`);
        lines.push(indentBlock(entry.diffStat || "(no changes)", "      "));
      }
    } else { lines.push("    (no tracked changes)"); }
    return lines.join("\n");
  }).join("\n");
}

function renderRepoStates(repoStates) {
  if (!repoStates.length) return ["(no git repositories found)"];
  return repoStates.flatMap(({ repo, status, diffStat, log: logOut }) => [
    `[${repo.name}] ${repo.path}`, "git status (--short):", status || "(clean)", "",
    "Current accumulated changes (diff --stat):", diffStat || "(no diff)", "",
    "Recent commits (log -10 --oneline):", logOut || "(no commits)", "",
  ]).slice(0, -1);
}

function indentBlock(text, prefix) { return String(text).split("\n").map((line) => `${prefix}${line}`).join("\n"); }

// ── plugin ──

function loadTurns(root) {
  const turnsPath = path.join(root, TURNS_FILE);
  try {
    const raw = readFileSync(turnsPath, "utf-8");
    const p = JSON.parse(raw);
    if (Array.isArray(p)) return sanitizeTurns(p);
    log("ignored invalid turns payload: root JSON value is not an array");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log("failed to load turns:", err?.message);
      if (err instanceof SyntaxError) backupMalformedTurns(turnsPath);
    }
  }
  return [];
}

function backupMalformedTurns(turnsPath) {
  if (malformedTurnsBackups.has(turnsPath)) return;
  malformedTurnsBackups.add(turnsPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${turnsPath}.malformed-${stamp}.bak`;
  try {
    copyFileSync(turnsPath, backupPath);
    log("backed up malformed turns file:", backupPath);
  } catch (err) {
    log("failed to back up malformed turns file:", err?.message);
  }
}

function saveTurns(root, turns) {
  try {
    mkdirSync(path.join(root, ".opencode/local-code"), { recursive: true });
    const payload = sanitizeTurns(turns);
    const existing = loadTurns(root);
    const merged = mergeTurns(existing, payload);
    writeFileSync(path.join(root, TURNS_FILE), JSON.stringify(merged, null, 2));
  } catch (err) { log("failed to save turns:", err?.message); }
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

function isStaleDirectModelEvent(override, model) {
  return Boolean(override && model === override.previous && model !== override.target);
}

function extractDiffStats(summaryDiffs) {
  if (!Array.isArray(summaryDiffs) || !summaryDiffs.length) return [];
  const seen = new Set(); const stats = [];
  for (const entry of summaryDiffs) {
    const file = entry?.file;
    if (isInternalDiffPath(file)) continue;
    if (!file || seen.has(file)) continue;
    seen.add(file);
    stats.push({ name: file.split("/").pop() || file, path: file, diffStat: `${typeof entry?.patch === "string" ? entry.patch.length : 0} bytes changed` });
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

function readPromptHistory() {
  const historyPath = promptHistoryPath();
  if (!historyPath) return [];
  try { return readFileSync(historyPath, "utf-8").split("\n").filter(Boolean); } catch { return []; }
}

function latestPromptHistoryInputSince(cursor) {
  const lines = readPromptHistory();
  const nextCursor = lines.length;
  const inputs = lines.slice(cursor).map((line) => {
    try { return JSON.parse(line)?.input; } catch { return undefined; }
  }).filter((input) => typeof input === "string" && input.trim());
  return { input: inputs.at(-1), cursor: nextCursor };
}

export const LocalCodeOpenCodePlugin = ({ client, directory, project }) => {
  const root = directory ?? project?.path ?? process.cwd();
  let sessionID = null;
  let currentModel = "unknown";
  let currentAgent = "build";
  let turns = loadTurns(root);
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
  let promptHistoryCursor = readPromptHistory().length;

  log("loaded", turns.length, "previous turns");

  function modelStr(modelObj, fallback = "unknown") {
    if (!modelObj) return fallback;
    const pid = modelObj.providerID || "";
    const mid = modelObj.modelID || modelObj.id || "";
    return pid && mid ? `${pid}/${mid}` : fallback;
  }

  async function injectContext(nextModel) {
    if (!sessionID) { log("no sessionID, skipping injection"); return; }
    if (switching) { log("already switching, skip"); return; }
    switching = true;
    try {
      const payload = buildContextPayload({ cwd: root, previousModel: currentModel, nextModel });

      const hasRelevantChanges = payload.repoStates.some((s) => s.status || s.diffStat);
      if (!payload.repos.length || !hasRelevantChanges) {
        if (!payload.repos.length) log("no repos found, skipping injection");
        else log("no changes detected, skipping injection");
        currentModel = nextModel;
        return;
      }

      if (turns.length) payload.turnLog = turns;
      const text = renderModelHandoffPrompt(payload);
      try {
        await client.session.prompt({ path: { id: sessionID }, body: { noReply: true, parts: [{ type: "text", text }] } });
        log("context injected, turns:", turns.length, "model:", nextModel);
      } catch (err) { log("context injection failed:", err?.message); }
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
      saveTurns(root, turns);
      return;
    }
    const after = collectDiffSnapshot({ cwd: root });
    const diffStats = diffStatsBetweenSnapshots(pendingDiffSnapshot, after);
    if (diffStats.length) turn.diffStats = diffStats;
    if (!turn.request && !turn.diffStats.length) turns.pop();
    finalizedUserMessages.add(messageID);
    pendingMessageID = null;
    pendingDiffSnapshot = null;
    pendingTurnDraft = null;
    saveTurns(root, turns);
    log("finalized turn diff stats:", diffStats.length);
  }

  function materializePendingTurn(request, messageID = pendingMessageID) {
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

  function recoverDeferredTurnFromPromptHistory() {
    if (!deferredTurnDrafts.size) return false;
    const recovered = latestPromptHistoryInputSince(promptHistoryCursor);
    promptHistoryCursor = recovered.cursor;
    const request = recovered.input;
    if (!request || isLocalCodeHandoffText(request) || parseDirectModelCommand(request)) return false;
    const messageID = [...deferredTurnDrafts.keys()].at(-1);
    const turn = materializePendingTurn(request, messageID);
    turn.request = request;
    saveTurns(root, turns);
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
      saveTurns(root, turns);
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
      saveTurns(root, turns);
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
              saveTurns(root, turns);
              log("ignored injected handoff turn");
              return;
            }
            const turn = materializePendingTurn(part.text, part.messageID);
            turn.request = part.text;
            saveTurns(root, turns);
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
            saveTurns(root, turns);
            log("ignored direct /model turn");
            return;
          }
          if (await handleDirectModelCommand(info.id, request)) return;
          if (isLocalCodeHandoffText(request)) {
            pendingMessageID = null;
            pendingDiffSnapshot = null;
            pendingTurnDraft = null;
            deferredTurnDrafts.delete(info.id);
            saveTurns(root, turns);
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
              const turn = materializePendingTurn(request, info.id);
              turn.request = request;
              saveTurns(root, turns);
              log("updated pending turn:", info.id);
            }
            return;
          }
          if (pendingMessageID === info.id) {
            const last = turns.findLast((entry) => entry.messageID === info.id);
            if (!last) {
              if (request && !isLocalCodeHandoffText(request)) {
                const turn = materializePendingTurn(request, info.id);
                turn.request = request;
                saveTurns(root, turns);
                log("updated pending turn:", info.id);
              }
              return;
            }
            if (request && !isLocalCodeHandoffText(request)) last.request = request;
            const fallbackDiffStats = extractDiffStats(info.summary?.diffs);
            if (!last.diffStats.length && fallbackDiffStats.length) last.diffStats = fallbackDiffStats;
            saveTurns(root, turns);
            log("updated pending turn:", info.id);
            return;
          }
          await finalizePendingTurn();
          if (info.model) currentModel = modelStr(info.model, currentModel);
          if (info.agent) currentAgent = info.agent;
          const initialDiffStats = extractDiffStats(info.summary?.diffs);
          const before = collectDiffSnapshot({ cwd: root });
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
          saveTurns(root, turns);
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
        recoverDeferredTurnFromPromptHistory();
        if (turns.length > 0) { saveTurns(root, turns); log("session idle, turns saved:", turns.length); }
      }
    },
  };
};

export default LocalCodeOpenCodePlugin;
