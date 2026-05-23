# local-code-opencode-plugin

OpenCode TUI 안에서 모델을 바꿀 때, 기존 `local-code`의 핵심 아이디어인 **git 상태 기반 handoff context**를 새 모델 문맥으로 주입하기 위한 초안 프로젝트다.

이 저장소는 Hermes와 무관하다. 목표는 OpenCode TUI 내부에서 자연스럽게 동작하는 플러그인/커맨드 companion이다.

## 목표

```text
OpenCode TUI
  ├─ 평소 작업: OpenCode가 그대로 처리
  ├─ 모델 전환: /lc-model sonnet 또는 /lc-sonnet
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
- OpenCode custom command 템플릿
  - `/lc-sonnet`
  - `/lc-qwen`
  - `/lc-kimi`
  - `/lc-review`
- OpenCode plugin 초안
  - 이벤트 payload spike용 debug logging
  - `/lc-model <profile>` intercept 후보 구조
  - session `noReply:true` context injection 후보 코드

아직 spike 필요:

- OpenCode plugin event payload에서 현재 session id를 안정적으로 얻는 방법
- native `/models` 선택 이벤트 감지 가능 여부
- `PATCH /config` 또는 `client.session.prompt({ model })` 중 TUI 현재 모델과 가장 잘 동기화되는 방식
- message/session event로 local-code식 turnLog를 재구성하는 정확한 before/after 타이밍

## 빠른 사용: command 방식 MVP

프로젝트에 command 템플릿을 복사한다.

```bash
mkdir -p .opencode/commands
cp templates/opencode/commands/*.md .opencode/commands/
```

OpenCode TUI 안에서:

```text
/lc-sonnet 계속 이어서 테스트까지 봐줘
/lc-qwen 빠르게 구조만 훑어줘
/lc-review 현재 diff 리뷰해줘
```

각 command는 `model:` frontmatter로 해당 turn 모델을 지정하고, 본문에서 다음 CLI 출력을 prompt에 주입한다.

```md
!`lc-opencode-context --next-model anthropic/claude-sonnet-4-5`
```

## CLI

```bash
lc-opencode-context --cwd . --previous-model openai/gpt-5-codex --next-model anthropic/claude-sonnet-4-5
```

출력 예:

```text
[Local-code model handoff]

이전 모델: openai/gpt-5-codex
새 모델: anthropic/claude-sonnet-4-5

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

- `docs/ARCHITECTURE.md` — 최종 plugin 구조
- `docs/SPIKES.md` — OpenCode plugin에서 검증할 항목
