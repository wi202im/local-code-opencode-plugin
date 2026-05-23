# Implementation Status

이 문서는 `local-code-opencode-plugin`이 현재 어디까지 구현됐고, 최종적으로 어디까지 가야 하는지 정리한다.

## 한 줄 요약

현재 저장소는 **local-code식 git handoff context 생성기 + OpenCode custom command bridge 초안**까지 구현되어 있다.

최종 목표인 **OpenCode TUI 내부 모델 전환 시점에 자동으로 git 기반 context를 주입하는 native plugin**은 아직 spike/검증 단계가 남아 있다.

대략적인 전체 구현율은 **35~40%** 수준으로 본다.

## 최종 목표

OpenCode TUI 안에서 모델을 바꿀 때, 대화 transcript가 아니라 **git working tree/status/diff/log**를 source of truth로 삼아 새 모델에게 이어받을 context를 주입한다.

목표 UX:

```text
OpenCode TUI에서 평소처럼 작업
  ↓
모델 전환 발생
  - /lc-model sonnet
  - /lc-sonnet 같은 custom command
  - 가능하면 native /models 선택 이벤트
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
- 모델 전환/명령 시점에만 개입한다.
- 사용자 승인 없이 `push`, `merge`, `deploy`, `publish`, `release`하지 말라는 안전 문구를 handoff에 포함한다.
- turnLog는 session-local/bounded cache로만 사용한다.

## 현재 구현된 것

### 1. Git context core

구현율: **70~80%**

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

### 2. OpenCode custom command bridge

구현율: **50~60%**

구현 파일:

- `templates/opencode/commands/lc-sonnet.md`
- `templates/opencode/commands/lc-qwen.md`
- `templates/opencode/commands/lc-kimi.md`
- `templates/opencode/commands/lc-review.md`

현재 의도한 방식:

1. 사용자가 프로젝트의 `.opencode/commands/`에 템플릿을 복사한다.
2. OpenCode TUI에서 `/lc-sonnet`, `/lc-qwen` 같은 custom command를 실행한다.
3. command frontmatter의 `model:`이 해당 turn의 모델을 지정한다.
4. command body의 shell injection이 `lc-opencode-context`를 실행해 git handoff context를 prompt에 포함한다.
5. 사용자의 `$ARGUMENTS`와 함께 새 모델이 이어서 답한다.

설치 예시:

```bash
mkdir -p .opencode/commands
cp templates/opencode/commands/*.md .opencode/commands/
```

OpenCode TUI 예시:

```text
/lc-sonnet 이어서 테스트까지 봐줘
/lc-qwen 구조 빠르게 훑고 다음 작업 제안해줘
/lc-review 현재 diff 리뷰해줘
```

주의:

- 이 방식은 native plugin이 아니라 command bridge다.
- OpenCode의 custom command `model:` frontmatter와 shell output injection이 실제 사용 환경에서 기대대로 동작하는지 로컬 스모크 테스트가 필요하다.

### 3. Native OpenCode plugin draft

구현율: **15~25%**

구현 파일:

- `src/plugin.js`

현재 들어간 것:

- OpenCode plugin export 형태 초안
- event payload debug logging 후보
- `/lc-model <profile>` command intercept 후보
- `client.session.prompt({ noReply: true, parts: [...] })` 기반 context-only injection 후보
- `client.config.update({ model })` 기반 모델 상태 변경 후보
- TUI toast 표시 후보

아직 확정되지 않은 것:

- plugin hook 이름과 payload shape가 현재 OpenCode 버전에서 정확히 맞는지
- `tui.command.execute`에서 현재 session id를 안정적으로 얻을 수 있는지
- `client.session.prompt(... noReply: true ...)`가 실제 TUI session의 다음 turn 문맥에 반영되는지
- `client.config.update({ model })`이 TUI의 현재 모델 표시/상태와 동기화되는지
- native `/models` 선택 이벤트를 plugin이 감지할 수 있는지

### 4. Model profile mapping

구현율: **40~50%**

구현 파일:

- `src/profiles.js`

현재 profile 초안:

- `sonnet` → `anthropic/claude-sonnet-4-5`
- `qwen` → `openrouter/qwen/qwen3-coder`
- `kimi` → `openrouter/moonshotai/kimi-k2`
- `review` → `openrouter/deepseek/deepseek-chat`

남은 것:

- 사용자 환경의 실제 OpenCode provider/model id와 맞는지 확인
- repo-local 설정 파일로 외부화할지 결정
- `.opencode/local-code.json` 같은 config를 둘지 결정

### 5. turnLog / 작업 단위 추적

구현율: **10~20%**

현재 상태:

- `src/handoff.js`에는 turnLog를 받아 렌더링할 수 있는 구조가 있다.
- 하지만 OpenCode event에서 turnLog를 실제로 수집하는 코드는 아직 없다.

최종 목표:

- user message 시작 전 git snapshot 저장
- session idle 이후 diff stat 수집
- 각 turn을 다음 형태로 저장

```js
{
  request,
  model,
  agent,
  diffStats,
  createdAt
}
```

- 긴 turnLog는 local-code 원칙대로 처음 3개 + 최근 7개 sliding window로 렌더링
- durable transcript/state file을 만들지 않고 session-local bounded cache로만 유지

## 아직 해야 할 핵심 spike

상세 항목은 `docs/SPIKES.md`에 있다.

우선순위 높은 검증:

1. **custom command MVP 스모크 테스트**
   - `.opencode/commands`에 템플릿 복사
   - OpenCode TUI에서 `/lc-sonnet`, `/lc-qwen`, `/lc-review` 실행
   - `model:` frontmatter가 실제로 해당 command turn의 모델을 바꾸는지 확인
   - shell injection으로 `lc-opencode-context` 출력이 prompt에 들어가는지 확인

2. **plugin event payload map 확보**
   - `LOCAL_CODE_OPENCODE_DEBUG=1 opencode`로 실행
   - 일반 메시지, session idle, `/models`, custom command 실행 시 event payload keys 기록
   - 현재 session id 위치 확인

3. **noReply injection 검증**
   - plugin 또는 OpenCode client에서 `noReply:true` message를 넣는다.
   - 다음 TUI 질문에서 주입한 marker를 모델이 기억하는지 확인한다.

4. **모델 전환 방법 확정**
   - `client.config.update({ model })`
   - `client.session.prompt({ model, parts })`
   - custom command `model:` frontmatter
   - native `/models` event hook

5. **turnLog 수집 타이밍 확정**
   - user message before snapshot
   - session idle after snapshot
   - diff stat 계산

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
node bin/lc-opencode-context.js --cwd . --next-model anthropic/claude-sonnet-4-5
```

출력에 다음이 포함되어야 한다.

- `[Local-code model handoff]`
- 현재 repo 이름
- `git status --short`
- `git diff --stat`
- `git log -10 --oneline`
- 승인 없는 push/merge/deploy/publish/release 금지 문구

### 4. 다른 프로젝트에서 command MVP 테스트

테스트하고 싶은 실제 OpenCode 작업 repo에서:

```bash
mkdir -p .opencode/commands
cp /path/to/local-code-opencode-plugin/templates/opencode/commands/*.md .opencode/commands/
```

그리고 `lc-opencode-context`가 PATH에 있어야 한다.
간단히는 저장소에서 npm link를 사용할 수 있다.

```bash
cd /path/to/local-code-opencode-plugin
npm link
```

그 다음 실제 작업 repo에서 OpenCode 실행:

```bash
opencode
```

TUI 안에서:

```text
/lc-sonnet 현재 상태 이어서 설명해줘
/lc-qwen 현재 diff 기준으로 다음 구현 계획 세워줘
/lc-review 현재 변경사항 리뷰해줘
```

확인할 것:

- command가 OpenCode에 노출되는지
- command 실행 시 에러 없이 shell injection이 동작하는지
- 지정한 `model:`이 실제 응답 모델에 반영되는지
- prompt 안에 git handoff context가 반영되는지

## 구현율 요약

- Git context core: **70~80%**
- CLI handoff generator: **70~80%**
- OpenCode custom command bridge: **50~60%**
- Native OpenCode plugin: **15~25%**
- turnLog/session integration: **10~20%**
- 전체 최종 목표 기준: **35~40%**

## 다음 개발 순서 제안

1. custom command MVP를 실제 OpenCode TUI에서 먼저 검증한다.
2. command bridge가 동작하면 README에 실사용 절차를 확정한다.
3. plugin debug logging으로 event payload map을 확보한다.
4. session id 획득과 noReply injection을 검증한다.
5. `/lc-model <profile>` native command를 구현한다.
6. 가능하면 native `/models` 선택 이벤트 후 자동 context injection을 붙인다.
7. turnLog 수집/렌더링을 추가한다.
8. 모델 profile 설정을 repo-local config로 외부화한다.

## 현재 결론

지금 저장소는 **로컬 컴퓨터에서 받아서 custom command MVP를 테스트해볼 가치가 있는 상태**다.

다만 아직 최종 plugin 완성본은 아니며, 가장 먼저 확인해야 할 것은 다음 두 가지다.

1. OpenCode custom command의 `model:` frontmatter가 실제 모델 전환에 충분한지
2. shell injection으로 생성한 local-code handoff context가 OpenCode prompt에 안정적으로 포함되는지
