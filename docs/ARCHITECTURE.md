# Architecture Draft

## Product shape

`local-code-opencode-plugin` is not a replacement TUI and not a Hermes integration. It is an OpenCode companion that brings the useful `local-code` idea into OpenCode:

> Model switching is a handoff event, and git state is the handoff payload.

## Final flow

```text
User in OpenCode TUI
  ↓
/lc-model sonnet          # MVP stable path
or native /models         # later, if events are reliable
  ↓
Plugin builds local-code style handoff context
  ↓
Plugin injects context into current OpenCode session with noReply:true
  ↓
Plugin changes target model or schedules next prompt model
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
  - OpenCode event hooks
  - `/lc-model <profile>` candidate
  - `noReply:true` context injection candidate
- `templates/opencode/commands/*.md`
  - command-based MVP before plugin event behavior is fully verified

## Why command MVP first

OpenCode officially supports command frontmatter `model:` and shell output injection via `!\`command\``. That is enough to prove the core UX without depending on undocumented model selector event details.

## Why plugin final

The command MVP cannot reliably observe every user turn, so it cannot recreate the original local-code `turnLog` quality. A plugin can listen to OpenCode message/session events and build a session-local turn map.

## Open questions

1. What exact event fires after native `/models` selection?
2. Does the event payload include previous/new model?
3. How should a plugin get the active TUI session id?
4. Does `PATCH /config { model }` update TUI status immediately?
5. Is `noReply:true` context visible to the next model in the same session without polluting user-visible transcript?
