import { execFileSync } from "node:child_process";
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const execFileAsync = execFileSync;
const TURNS_FILE = ".opencode/local-code/turns.json";
const TURN_LOG_MAX = 50;
const HANDOFF_PREFIX = "[Local-code model handoff]";
const DEFAULT_HEAD_KEEP = 3;
const DEFAULT_TAIL_KEEP = 7;

const DEBUG = process.env.LOCAL_CODE_OPENCODE_DEBUG === "1";
const log = (...args) => DEBUG && console.error("[lc-plugin]", ...args);

// ── context (sync) ──

function buildContextPayload({ cwd = process.cwd(), previousModel = "unknown", nextModel = "unknown", logLimit = 10 } = {}) {
  const workspaceRoot = path.resolve(cwd);
  const repos = detectWorkspaceRepos(workspaceRoot);
  const repoStates = repos.map((repo) => collectRepoState(repo, { logLimit }));
  return { kind: "local-code-opencode-model-handoff", generatedAt: new Date().toISOString(), workspaceRoot, previousModel, nextModel, repos, repoStates, turnLog: [] };
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
    status: git(repo.path, ["status", "--short"]),
    diffStat: git(repo.path, ["diff", "--stat"]),
    log: git(repo.path, ["log", `-${logLimit}`, "--oneline"]),
  };
}

function hasDotGit(dir) {
  try { const s = statSync(path.join(dir, ".git")); return s.isDirectory() || s.isFile(); } catch { return false; }
}

function isGitRepo(dir) {
  if (hasDotGit(dir)) return true;
  const result = git(dir, ["rev-parse", "--show-toplevel"]);
  return path.resolve(result.trim()) === path.resolve(dir);
}

function git(cwd, args) {
  try { return execFileSync("git", args, { cwd, maxBuffer: 1024 * 1024, encoding: "utf-8" }).trim(); } catch { return ""; }
}

// ── handoff ──

function renderModelHandoffPrompt(payload, options = {}) {
  const headKeep = options.headKeep ?? DEFAULT_HEAD_KEEP;
  const tailKeep = options.tailKeep ?? DEFAULT_TAIL_KEEP;
  const turnLog = payload.turnLog ?? [];
  const { headerLabel, workUnitsBlock } = formatWorkUnits(turnLog, { headKeep, tailKeep });
  return [
    "[Local-code model handoff]", "",
    `이전 모델: ${payload.previousModel ?? "unknown"}`,
    `새 모델: ${payload.nextModel ?? "unknown"}`,
    "",
    "현재 git 상태와 작업 단위를 source of truth로 삼아 이어가세요.",
    "사용자 승인 없이 push, merge, deploy, publish, release하지 마세요.",
    "", headerLabel, workUnitsBlock, "",
    "등록된 repos:",
    ...(payload.repos ?? []).map((repo) => `- ${repo.name}: ${repo.path}`),
    "",
    ...renderRepoStates(payload.repoStates ?? []),
  ].join("\n").trimEnd();
}

function formatWorkUnits(turnLog, { headKeep, tailKeep }) {
  if (!turnLog.length) return { headerLabel: "작업 단위:", workUnitsBlock: "(없음 — 현재 git 상태를 기준으로 이어가세요)" };
  const threshold = headKeep + tailKeep;
  if (turnLog.length <= threshold) return { headerLabel: `작업 단위 (총 ${turnLog.length}개):`, workUnitsBlock: renderTurns(turnLog, 1) };
  const headTurns = turnLog.slice(0, headKeep);
  const tailTurns = turnLog.slice(-tailKeep);
  const skipped = turnLog.length - headKeep - tailKeep;
  return {
    headerLabel: `작업 단위 (총 ${turnLog.length}개 중 처음 ${headKeep} + 최근 ${tailKeep}):`,
    workUnitsBlock: [renderTurns(headTurns, 1), `    ... (중간 ${skipped}개 turn 생략 — 누적 변경은 아래 git diff/status로 확인) ...`, renderTurns(tailTurns, turnLog.length - tailKeep + 1)].join("\n"),
  };
}

function renderTurns(turns, startIndex) {
  return turns.map((turn, index) => {
    const lines = [`${startIndex + index}. (${turn.model ?? turn.agent ?? "?"}) ${turn.request ?? "(unknown request)"}`];
    if (Array.isArray(turn.diffStats) && turn.diffStats.length) {
      for (const entry of turn.diffStats) {
        lines.push(`    [${entry.name}] ${entry.path}`);
        lines.push(indentBlock(entry.diffStat || "(변경 없음)", "      "));
      }
    } else { lines.push("    (변경 추적 없음)"); }
    return lines.join("\n");
  }).join("\n");
}

function renderRepoStates(repoStates) {
  if (!repoStates.length) return ["(git repo를 찾지 못했습니다)"];
  return repoStates.flatMap(({ repo, status, diffStat, log: logOut }) => [
    `[${repo.name}] ${repo.path}`, "git status (--short):", status || "(clean)", "",
    "현재 누적 변경 통계 (diff --stat):", diffStat || "(no diff)", "",
    "최근 커밋 (log -10 --oneline):", logOut || "(no commits)", "",
  ]).slice(0, -1);
}

function indentBlock(text, prefix) { return String(text).split("\n").map((line) => `${prefix}${line}`).join("\n"); }

// ── plugin ──

function loadTurns(root) {
  try { const raw = readFileSync(path.join(root, TURNS_FILE), "utf-8"); const p = JSON.parse(raw); if (Array.isArray(p)) return sanitizeTurns(p); } catch {}
  return [];
}

function saveTurns(root, turns) {
  try {
    mkdirSync(path.join(root, ".opencode/local-code"), { recursive: true });
    writeFileSync(path.join(root, TURNS_FILE), JSON.stringify(sanitizeTurns(turns), null, 2));
  } catch (err) { log("failed to save turns:", err?.message); }
}

function isLocalCodeHandoffText(text) {
  return typeof text === "string" && text.trimStart().startsWith(HANDOFF_PREFIX);
}

function sanitizeTurns(turns) {
  return turns.filter((turn) => !isLocalCodeHandoffText(turn?.request)).slice(-TURN_LOG_MAX);
}

function extractDiffStats(summaryDiffs) {
  if (!Array.isArray(summaryDiffs) || !summaryDiffs.length) return [];
  const seen = new Set(); const stats = [];
  for (const entry of summaryDiffs) {
    const file = entry?.file; if (!file || seen.has(file)) continue;
    seen.add(file);
    stats.push({ name: file.split("/").pop() || file, path: file, diffStat: `${typeof entry?.patch === "string" ? entry.patch.length : 0} bytes changed` });
  }
  return stats;
}

export const LocalCodeOpenCodePlugin = ({ client, directory, project }) => {
  const root = directory ?? project?.path ?? process.cwd();
  let sessionID = null;
  let currentModel = "unknown";
  let currentAgent = "build";
  let turns = loadTurns(root);
  let pendingMessageID = null;
  const partBuffer = new Map();
  let seenInitialModel = false;
  let switching = false;

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
        log("model switched:", currentModel, "→", nextModel);
        await injectContext(nextModel);
      }

      if (type === "session.updated") {
        const model = properties?.info?.model;
        if (!model) return;
        const nextModel = modelStr(model);
        if (!seenInitialModel) { currentModel = nextModel; seenInitialModel = true; return; }
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
          if (pendingMessageID === part.messageID && turns.length > 0) {
            if (isLocalCodeHandoffText(part.text)) {
              turns.pop();
              pendingMessageID = null;
              saveTurns(root, turns);
              log("ignored injected handoff turn");
              return;
            }
            turns[turns.length - 1].request = part.text;
            saveTurns(root, turns);
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
          if (isLocalCodeHandoffText(request)) {
            pendingMessageID = null;
            saveTurns(root, turns);
            log("ignored injected handoff turn");
            return;
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
          saveTurns(root, turns);
          log("turn #" + turns.length, "model:", currentModel);
        }

        if (role === "assistant" && info.modelID && info.providerID) {
          currentModel = `${info.providerID}/${info.modelID}`;
        }
      }

      if (type === "session.idle") {
        if (properties?.sessionID) sessionID = properties.sessionID;
        if (turns.length > 0) { saveTurns(root, turns); log("session idle, turns saved:", turns.length); }
      }
    },
  };
};

export default LocalCodeOpenCodePlugin;
