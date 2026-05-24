# local-code-opencode-plugin v.1.0.0

OpenCode TUI 안에서 모델을 바꿀 때, 기존 `local-code`의 핵심 아이디어인 **git 상태 기반 handoff context**를 새 모델 문맥으로 주입하는 플러그인이다.

## 목표

```text
OpenCode TUI
  ├─ 평소 작업: OpenCode가 그대로 처리
  ├─ 모델 전환: native /models picker
  ├─ 직접 입력: /model provider/model 형태도 handoff trigger로 감지
  └─ 전환 시점:
        1. 현재 workspace/repo git 상태 수집
        2. local-code 스타일 handoff prompt 생성
        3. 현재 OpenCode session에 context-only(noReply) 주입
        4. 새 모델이 이어서 작업
```

## 현재 구현

구현됨:

- `lc-opencode-context` CLI
  - workspace/단일 repo 자동 감지
  - immediate child git repo가 2개 이상이면 multi-repo workspace로 처리
  - root가 git repo 아닐 때 단일 child repo도 인식
  - repo별 `git status --short`, `git diff --stat`, `git log -10 --oneline` 수집
  - handoff prompt 출력
- OpenCode native plugin (`src/plugin.js`)
  - `session.created` → sessionID 획득
  - `session.next.model.switched` → native `/models` picker 전환 시 context 자동 주입
  - 직접 입력 `/model provider/model` → user text event로 감지해 context 주입
  - injected handoff와 직접 `/model` command가 turnLog에 남지 않도록 필터링
  - 직접 `/model` command 뒤 OpenCode가 내보내는 stale model event를 무시
  - `session.next.agent.switched` → agent 추적
  - `message.part.updated` → user message text 캡처, request 매칭
  - `message.updated` → user turn 생성, 시작 시점 git diff snapshot 캡처, turnLog 누적
  - `session.idle` → 종료 시점 git diff snapshot 비교 후 turn 저장
  - TurnLog persistence: `.opencode/local-code/turns.json` (최대 50개)
  - Per-turn diff stats: staged/unstaged tracked 변경과 untracked 파일을 git snapshot 비교로 기록
  - Sliding window 렌더링: 처음 3 + 최근 7개 turn
  - 방어 로직: repo 미발견 또는 변경사항 없을 시 injection 스킵

아직 작업 필요:

- `.opencode/local-code.json` 같은 per-project config 지원
- plugin 이벤트 핸들러 테스트 구조 분리/확장

## 사용법

1. `plugin.js`를 OpenCode 플러그인으로 등록한다.
2. OpenCode TUI 안에서 평소처럼 작업한다.
3. `/models` picker로 모델을 전환하면 플러그인이 자동으로 git handoff context를 새 모델에 주입한다.
4. 채팅창에 `/model provider/model`처럼 직접 입력해도 handoff context 주입을 트리거한다.

OpenCode 1.15.10 기준으로 직접 입력 `/model provider/model`은 native 모델 전환 명령이 아니라 일반 user message로 들어온다. 그래서 플러그인은 이 경로를 `message.part.updated`/`message.updated`에서 감지해 handoff를 주입하고, 해당 command가 turnLog에 남지 않도록 처리한다. 실제 모델 선택 자체는 OpenCode의 native `/models` picker가 가장 정확한 경로다.

## CLI

```bash
lc-opencode-context --cwd . --previous-model openai/gpt-5.3-codex --next-model opencode-go/deepseek-v4-pro
```

출력 예:

```text
[Local-code model handoff]

이전 모델: openai/gpt-5.3-codex
새 모델: opencode-go/deepseek-v4-pro

현재 git 상태와 작업 단위를 source of truth로 삼아 이어가세요.
사용자 승인 없이 push, merge, deploy, publish, release하지 마세요.
...
```

## 설계 원칙

- 대화 transcript보다 repo state를 우선한다.
- 플러그인은 모델 전환 순간에만 개입한다.
- 기본 동작은 OpenCode TUI를 방해하지 않는다.
- 자동 commit/push/merge/deploy/release는 하지 않는다.
- multi-repo workspace는 immediate child git repo 2개 이상일 때만 자동 감지한다.
- OpenCode event 기반 turnLog는 캐시 수준으로만 다루고, durable source of truth는 git 상태로 둔다.

## 개발

```bash
npm test
npm run check
```

## 문서

- `docs/IMPLEMENTATION_STATUS.md` — 현재 구현 범위, 구현율, 최종 목표, 로컬 테스트 가이드
- `docs/ARCHITECTURE.md` — 최종 plugin 구조
- `docs/SPIKES.md` — OpenCode plugin에서 검증할 항목
