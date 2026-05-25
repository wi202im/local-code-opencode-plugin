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
    "이 메시지는 모델 전환용 배경 컨텍스트입니다. 이 handoff 자체에 답하지 마세요.",
    "다음 사용자 메시지가 오면 그 메시지의 지시를 최우선으로 따르세요. handoff 내용과 충돌하면 사용자 메시지가 우선입니다.",
    "",
    `이전 모델: ${payload.previousModel ?? "unknown"}`,
    `새 모델: ${payload.nextModel ?? "unknown"}`,
    "",
    "컨텍스트가 필요할 때만 현재 git 상태와 작업 단위를 참고하세요.",
    "사용자 승인 없이 push, merge, deploy, publish, release하지 마세요.",
    "",
    headerLabel,
    workUnitsBlock,
    "",
    "등록된 repos:",
    ...(payload.repos ?? []).map((repo) => `- ${repo.name}: ${repo.path}`),
    "",
    ...renderRepoStates(payload.repoStates ?? []),
  ].join("\n").trimEnd();
}

function formatWorkUnits(turnLog, { headKeep, tailKeep }) {
  if (!turnLog.length) return { headerLabel: "작업 단위:", workUnitsBlock: "(없음 — 현재 git 상태를 기준으로 이어가세요)" };
  const threshold = headKeep + tailKeep;
  if (turnLog.length <= threshold) {
    return { headerLabel: `작업 단위 (총 ${turnLog.length}개):`, workUnitsBlock: renderTurns(turnLog, 1) };
  }
  const headTurns = turnLog.slice(0, headKeep);
  const tailTurns = turnLog.slice(-tailKeep);
  const skipped = turnLog.length - headKeep - tailKeep;
  const tailStartIndex = turnLog.length - tailKeep + 1;
  return {
    headerLabel: `작업 단위 (총 ${turnLog.length}개 중 처음 ${headKeep} + 최근 ${tailKeep}):`,
    workUnitsBlock: [
      renderTurns(headTurns, 1),
      `    ... (중간 ${skipped}개 turn 생략 — 누적 변경은 아래 git diff/status로 확인) ...`,
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
        lines.push(indentBlock(entry.diffStat || "(변경 없음)", "      "));
      }
    } else {
      lines.push("    (변경 추적 없음)");
    }
    return lines.join("\n");
  }).join("\n");
}

function renderRepoStates(repoStates) {
  if (!repoStates.length) return ["(git repo를 찾지 못했습니다)"];
  return repoStates.flatMap(({ repo, status, diffStat, log }) => [
    `[${repo.name}] ${repo.path}`,
    "git status (--short):",
    status || "(clean)",
    "",
    "현재 누적 변경 통계 (diff --stat):",
    diffStat || "(no diff)",
    "",
    "최근 커밋 (log -10 --oneline):",
    log || "(no commits)",
    "",
  ]).slice(0, -1);
}

function indentBlock(text, prefix) {
  return String(text).split("\n").map((line) => `${prefix}${line}`).join("\n");
}
