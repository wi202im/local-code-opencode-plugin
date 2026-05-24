# Architecture Draft

## Product shape

`local-code-opencode-plugin` is not a replacement TUI and not a Hermes integration. It is an OpenCode companion that brings the useful `local-code` idea into OpenCode:

> Model switching is a handoff event, and git state is the handoff payload.

## Final flow

```text
User in OpenCode TUI
  ↓
/lc-deepseek, /lc-codex, ...    # custom commands (model: frontmatter)
or native /model                # session.next.model.switched hook
  ↓
Plugin builds local-code style handoff context
  ↓
Plugin injects context into current OpenCode session with noReply:true
  ↓
New model continues using git status/diff/log as source of truth
```

## Modules

- `src/context.js`
  - workspace/repo detection
  - repo state collection
- `src/handoff.js`
  - local-code style model handoff prompt rendering
  - sliding-window turnLog renderer placeholder
- `src/plugin.js`
  - OpenCode event hooks (session.created, model.switched, command.executed, message.updated, session.idle)
  - TurnLog collection and persistence (`.opencode/local-code/turns.json`)
  - `noReply:true` context injection
- `templates/opencode/commands/*.md`
  - command-based MVP before plugin event behavior is fully verified

## Why command MVP first

OpenCode officially supports command frontmatter `model:` and shell output injection via `!\`command\``. That is enough to prove the core UX without depending on undocumented model selector event details.

## Why plugin final

The command MVP cannot reliably observe every user turn, so it cannot recreate the original local-code `turnLog` quality. A plugin can listen to OpenCode message/session events and build a session-local turn map.

## Open questions

1. Where exactly in `message.updated` is the user message text (for turnLog `request` field)?
2. Does `noReply:true` context reliably carry across model switches in all scenarios?

## Resolved

1. Event after native `/models` selection → `session.next.model.switched` (verified in OpenCode 1.15.10)
2. Event payload includes previous/new model info → yes, via `properties.model.{id,providerID}`
3. How to get active TUI session id → `session.created` / `message.updated` / `command.executed` / `session.idle`
4. Model state sync → Custom commands use `model:` frontmatter (OpenCode handles switching). Native switches use `session.next.model.switched` hook.
5. TurnLog approach → `message.updated` (role=user) for turn creation, `session.idle` for persistence
