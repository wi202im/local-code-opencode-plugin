# local-code-opencode-plugin v.1.0

OpenCode TUI 안에서 모델을 바꿀 때, 기존 `local-code`의 핵심 아이디어인 **git 상태 기반 handoff context**를 새 모델 문맥으로 주입하는 플러그인이다.

## 목표

```text
OpenCode TUI
  ├─ 평소 작업: OpenCode가 그대로 처리
  ├─ 모델 전환: native /model
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
  - `session.next.model.switched` → native `/model` 전환 시 context 자동 주입
  - `session.next.agent.switched` → agent 추적
  - `message.part.updated` → user message text 캡처, request 매칭
  - `message.updated` → user turn 생성, diff stats 캡처, turnLog 누적
  - `session.idle` → turn 저장
  - TurnLog persistence: `.opencode/local-code/turns.json` (최대 50개)
  - Sliding window 렌더링: 처음 3 + 최근 7개 turn
  - 방어 로직: repo 미발견 또는 변경사항 없을 시 injection 스킵

아직 작업 필요:

- Plugin 이벤트 핸들러 유닛 테스트

## 사용법

1. `plugin.js`를 OpenCode 플러그인으로 등록한다.
2. OpenCode TUI 안에서 평소처럼 작업한다.
3. `/model`로 모델을 전환하면 플러그인이 자동으로 git handoff context를 새 모델에 주입한다.

별도 명령어 없이 native `/model` 전환만으로 동작한다.

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
