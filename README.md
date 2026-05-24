# local-code-opencode-plugin

OpenCode TUI 안에서 모델을 바꿀 때, 기존 `local-code`의 핵심 아이디어인 **git 상태 기반 handoff context**를 새 모델 문맥으로 주입하기 위한 초안 프로젝트다.

이 저장소는 Hermes와 무관하다. 목표는 OpenCode TUI 내부에서 자연스럽게 동작하는 플러그인/커맨드 companion이다.

## 목표

```text
OpenCode TUI
  ├─ 평소 작업: OpenCode가 그대로 처리
  ├─ 모델 전환: /lc-deepseek, /lc-codex 등 custom command 또는 native /model
  └─ 전환 시점:
        1. 현재 workspace/repo git 상태 수집
        2. local-code 스타일 handoff prompt 생성
        3. 현재 OpenCode session에 context-only(noReply) 주입
        4. 새 모델이 이어서 작업
```

## 현재 초안 범위

구현됨:

- `lc-opencode-context` CLI
  - workspace/단일 repo 자동 감지
  - immediate child git repo가 2개 이상이면 multi-repo workspace로 처리
  - repo별 `git status --short`, `git diff --stat`, `git log -10 --oneline` 수집
  - OpenCode command에 넣기 좋은 handoff prompt 출력
- OpenCode custom command 템플릿 (6개)
  - `/lc-codex` — GPT-5.3 Codex (primary coding)
  - `/lc-gpt55` — GPT-5.5 Pro (highest quality)
  - `/lc-deepseek` — DeepSeek V4 Pro (general)
  - `/lc-qwen` — Qwen 3.6 Plus (cheap coding)
  - `/lc-kimi` — Kimi K2.6 (long-context)
  - `/lc-review` — plan agent, read-only review
- OpenCode native plugin (`src/plugin.js`)
  - `session.created` → sessionID 획득
  - `session.next.model.switched` → native `/model` 전환 시 자동 context 주입
  - `command.executed` → `/lc-*` 커맨드 감지 및 context 주입
  - `message.updated` → user turn 생성, diff stats 캡처, turnLog 누적
  - `session.idle` → turn 저장
  - TurnLog persistence: `.opencode/local-code/turns.json` (최대 50개)
  - Sliding window 렌더링: 처음 3 + 최근 7개 turn

아직 작업 필요:

- TurnLog에 user message text (`request` 필드) 캡처
- `.opencode/local-code.json` per-project config
- Plugin 이벤트 핸들러 유닛 테스트

## 빠른 사용: command 방식 MVP

프로젝트에 command 템플릿을 복사한다.

```bash
mkdir -p .opencode/commands
cp templates/opencode/commands/*.md .opencode/commands/
```

OpenCode TUI 안에서:

```text
/lc-deepseek 계속 이어서 테스트까지 봐줘
/lc-codex 이 기능 구현해줘
/lc-gpt55 복잡한 리팩토링 부탁해
/lc-qwen 빠르게 구조만 훑어줘
/lc-kimi 긴 로그 분석해줘
/lc-review 현재 diff 리뷰해줘
```

각 command는 `model:` frontmatter로 해당 turn 모델을 지정하고, 본문에서 다음 CLI 출력을 prompt에 주입한다.

```md
!`lc-opencode-context --next-model opencode-go/deepseek-v4-pro`
```

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
- 플러그인은 모델 전환/명령 순간에만 개입한다.
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
