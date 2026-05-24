# Implementation Status

이 문서는 `local-code-opencode-plugin`이 현재 어디까지 구현됐고, 최종적으로 어디까지 가야 하는지 정리한다.

## 한 줄 요약

현재 저장소는 **OpenCode TUI 내부에서 native `/model` 전환 시 event hook으로 자동 git handoff context를 주입하는 native plugin**이 동작하는 상태다.

대략적인 전체 구현율은 **80~85%** 수준으로 본다.

## 최종 목표

OpenCode TUI 안에서 모델을 바꿀 때, 대화 transcript가 아니라 **git working tree/status/diff/log**를 source of truth로 삼아 새 모델에게 이어받을 context를 주입한다.

목표 UX:

```text
OpenCode TUI에서 평소처럼 작업
  ↓
모델 전환 발생 (native /model)
  ↓
plugin이 현재 repo/workspace 상태 수집
  - git status --short
  - git diff --stat
  - git log -10 --oneline
  - 최근 작업 turn diff summary
  ↓
현재 session에 noReply context-only message 주입
  ↓
새 모델이 git 상태를 기준으로 자연스럽게 이어서 작업
```

최종형에서 지켜야 할 원칙:

- OpenCode TUI 기본 UX를 해치지 않는다.
- transcript나 durable handoff file을 source of truth로 만들지 않는다.
- git 상태를 최우선 source of truth로 삼는다.
- 모델 전환 시점에만 개입한다.
- 사용자 승인 없이 `push`, `merge`, `deploy`, `publish`, `release`하지 말라는 안전 문구를 handoff에 포함한다.
- turnLog는 session-local/bounded cache로만 사용한다.

## 현재 구현된 것

### 1. Git context core

구현율: **80~90%**

구현 파일:

- `src/context.js`
- `src/handoff.js`
- `bin/lc-opencode-context.js`
- `test/context.test.js`

현재 가능한 것:

- 현재 cwd가 단일 git repo인지 감지한다.
- immediate child git repo가 2개 이상이면 multi-repo workspace로 감지한다.
- 일반 하위 폴더를 repo로 오인하지 않도록 own `.git` entry 기준으로 child repo를 판정한다.
- repo별 상태를 수집한다.
  - `git status --short`
  - `git diff --stat`
  - `git log -10 --oneline`
- local-code 스타일 handoff prompt를 생성한다.
- 이전 모델/다음 모델 정보를 prompt에 넣는다.
- 사용자 승인 없이 위험한 외부 작업을 하지 말라는 문구를 포함한다.
- turnLog sliding window 렌더링 (처음 3 + 최근 7)

CLI 예시:

```bash
node bin/lc-opencode-context.js \
  --cwd . \
  --previous-model openai/gpt-5-codex \
  --next-model anthropic/claude-sonnet-4-5
```

패키지 bin으로 설치되면:

```bash
lc-opencode-context --cwd . --next-model anthropic/claude-sonnet-4-5
```

### 2. Native OpenCode plugin

구현율: **80~85%**

구현 파일:

- `src/plugin.js` (npm package entry)
- `.opencode/plugins/local-code-plugin.js` (local dev copy)

현재 들어간 것:

- OpenCode plugin export: `LocalCodeOpenCodePlugin` factory with `client`, `directory`, `project` params
- Event hook 기반 session/model/agent 추적:
  - `session.created` → sessionID 획득
  - `session.next.model.switched` → native `/model` 전환 시 context 자동 주입
  - `session.next.agent.switched` → agent 추적
  - `message.part.updated` → user message text 캡처, request 매칭
  - `message.updated` → user turn 생성, diff stats 캡처, turnLog 누적
  - `session.idle` → turn 저장
- `client.session.prompt({ noReply: true, parts: [...] })` 기반 context-only injection
- TurnLog persistence: `.opencode/local-code/turns.json` 파일에 저장/로드 (최대 50개)
- Sliding window 렌더링: 처음 3개 + 최근 7개 turn
- Per-turn diff stats: `message.updated`의 `info.summary.diffs`에서 추출
- 방어 로직: repo 미발견 또는 모든 repo clean 상태 시 injection 스킵
- Workspace detection: root가 git repo 아닐 때 단일 child repo도 인식

아직 확정되지 않은 것:

- `.opencode/local-code.json` per-project config (profiles, options)

### 3. Model profile mapping

구현율: **70~80%**

구현 파일:

- `src/profiles.js`

현재 profile:

- `codex` → `openai/gpt-5.3-codex` (primary coding)
- `gpt55` → `openai/gpt-5.5-pro` (highest quality)
- `deepseek` → `opencode-go/deepseek-v4-pro` (general)
- `qwen` → `opencode-go/qwen3.6-plus` (cheap coding)
- `kimi` → `opencode-go/kimi-k2.6` (long-context)
- `review` → `opencode-go/deepseek-v4-pro` (plan agent)

남은 것:

- repo-local 설정 파일로 외부화 (`.opencode/local-code.json`)
- 사용자 커스텀 profile 지원

### 4. turnLog / 작업 단위 추적

구현율: **80~85%**

현재 상태:

- `message.updated` (role=user) → model/agent 캡처, turn 생성
- `message.part.updated` → `part.messageID`로 user message text 매칭, `request` 필드 저장
- `info.summary.diffs` → per-turn diff stats 추출
- `session.idle` → turn 저장
- TurnLog shape: `{ model, agent, request, diffStats, createdAt }`
- Persistence: `.opencode/local-code/turns.json` (최대 50개)
- Sliding window: 처음 3 + 최근 7개 (handoff.js)

남은 것:

- 도구 호출 전후 diff stats 정확도 개선

## 아직 해야 할 항목

상세 spike 항목은 `docs/SPIKES.md`에 있다.

우선순위 높은 항목:

1. **Per-project config**
   - `.opencode/local-code.json` 으로 profiles, options 외부화

2. **테스트 커버리지 확장**
   - plugin 이벤트 핸들러 단위 테스트
   - handoff 렌더링 테스트

3. **턴 간 git diff 정확도 개선**
   - 도구 호출 전후 git diff 비교

## 로컬 테스트 가이드

### 1. 저장소 받기

```bash
git clone https://github.com/wi202im/local-code-opencode-plugin.git
cd local-code-opencode-plugin
```

### 2. 기본 검증

```bash
npm test
npm run check
```

현재 기준 기대 결과:

```text
npm test      # 3 tests passing
npm run check # syntax check passing
```

### 3. CLI context 출력 확인

```bash
node bin/lc-opencode-context.js --cwd . --next-model opencode-go/deepseek-v4-pro
```

출력에 다음이 포함되어야 한다.

- `[Local-code model handoff]`
- 현재 repo 이름
- `git status --short`
- `git diff --stat`
- `git log -10 --oneline`
- 승인 없는 push/merge/deploy/publish/release 금지 문구

### 4. 실제 OpenCode에서 플러그인 테스트

```
.prodebug/opencode.json 에 plugin 등록 후 OpenCode 실행:

1. OpenCode TUI 안에서 평소처럼 작업
2. /model 로 모델 전환
3. 새 모델이 git handoff context를 받아 자연스럽게 이어서 작업하는지 확인
```

## 구현율 요약

- Git context core: **80~90%**
- CLI handoff generator: **80~90%**
- Native OpenCode plugin: **80~85%**
- Model profiles: **70~80%**
- turnLog: **80~85%**
- 전체 최종 목표 기준: **80~85%**

## 다음 개발 순서 제안

1. TurnLog `request` 필드 캡처 (user message text)
2. `.opencode/local-code.json` per-project config 지원
3. Plugin 이벤트 핸들러 유닛 테스트
4. 턴 간 git diff 정확도 개선 (도구 호출 전후 비교)

## 현재 결론

지금 저장소는 **OpenCode TUI 안에서 event hook 기반으로 git handoff context를 자동 주입하는 native plugin**이 어느 정도 동작하는 상태다.

Event payload shapes는 OpenCode 1.15.10 기준으로 검증되었고, `session.next.model.switched` 기반 context injection과 turnLog persistence가 구현되어 있다.

남은 주요 작업은 per-project config 지원과 테스트 커버리지 확장이다.
