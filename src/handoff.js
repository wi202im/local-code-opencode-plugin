const DEFAULT_HEAD_KEEP = 3;
const DEFAULT_TAIL_KEEP = 7;

export function renderModelHandoffPrompt(payload, options = {}) {
  const headKeep = options.headKeep ?? DEFAULT_HEAD_KEEP;
  const tailKeep = options.tailKeep ?? DEFAULT_TAIL_KEEP;
  const turnLog = payload.turnLog ?? [];
  const { headerLabel, workUnitsBlock } = formatWorkUnits(turnLog, { headKeep, tailKeep });

  return [
    "[Local-code model handoff]",
    "",
    "This is background context for a model handoff. Do not answer this handoff message directly.",
    "When the next user message arrives, follow that user message first. If it conflicts with this handoff, the user message wins.",
    "",
    `Previous model: ${payload.previousModel ?? "unknown"}`,
    `Next model: ${payload.nextModel ?? "unknown"}`,
    "",
    "Use the current git state and work units only when they are relevant.",
    "Do not push, merge, deploy, publish, or release without explicit user approval.",
    "",
    headerLabel,
    workUnitsBlock,
    "",
    "Registered repos:",
    ...(payload.repos ?? []).map((repo) => `- ${repo.name}: ${repo.path}`),
    "",
    ...renderRepoStates(payload.repoStates ?? []),
  ].join("\n").trimEnd();
}

function formatWorkUnits(turnLog, { headKeep, tailKeep }) {
  if (!turnLog.length) return { headerLabel: "Work units:", workUnitsBlock: "(none - continue from the current git state)" };
  const threshold = headKeep + tailKeep;
  if (turnLog.length <= threshold) {
    return { headerLabel: `Work units (${turnLog.length} total):`, workUnitsBlock: renderTurns(turnLog, 1) };
  }
  const headTurns = turnLog.slice(0, headKeep);
  const tailTurns = turnLog.slice(-tailKeep);
  const skipped = turnLog.length - headKeep - tailKeep;
  const tailStartIndex = turnLog.length - tailKeep + 1;
  return {
    headerLabel: `Work units (${turnLog.length} total, first ${headKeep} + latest ${tailKeep}):`,
    workUnitsBlock: [
      renderTurns(headTurns, 1),
      `    ... (${skipped} middle turns omitted - use git diff/status below for accumulated changes) ...`,
      renderTurns(tailTurns, tailStartIndex),
    ].join("\n"),
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
    } else {
      lines.push("    (no tracked changes)");
    }
    return lines.join("\n");
  }).join("\n");
}

function renderRepoStates(repoStates) {
  if (!repoStates.length) return ["(no git repositories found)"];
  return repoStates.flatMap(({ repo, status, diffStat, log }) => [
    `[${repo.name}] ${repo.path}`,
    "git status (--short):",
    status || "(clean)",
    "",
    "Current accumulated changes (diff --stat):",
    diffStat || "(no diff)",
    "",
    "Recent commits (log -10 --oneline):",
    log || "(no commits)",
    "",
  ]).slice(0, -1);
}

function indentBlock(text, prefix) {
  return String(text).split("\n").map((line) => `${prefix}${line}`).join("\n");
}
