# Architecture Draft

## Product shape

`local-code-opencode-plugin` is not a replacement TUI and not a Hermes integration. It is an OpenCode companion that brings the useful `local-code` idea into OpenCode:

> Model switching is a handoff event, and git state is the handoff payload.

## Final flow

```text
User in OpenCode TUI
  ↓
native /models picker            # session.next.model.switched hook
or direct /model provider/model  # user text event fallback
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
  - sliding-window turnLog renderer
- `src/plugin.js`
  - OpenCode event hooks (session.created, session.next.model.switched, session.next.agent.switched, message.part.updated, message.updated, session.idle)
  - TurnLog collection and persistence (`.opencode/local-code/turns.json`)
  - Direct `/model provider/model` detection through user text events
  - Filtering for injected handoff/direct model command turns
  - `noReply:true` context injection
- `src/profiles.js`
  - splitModelID utility

## Why event-driven plugin

The plugin hooks `session.next.model.switched` to automatically inject git-based handoff context whenever the user switches models via the native `/models` picker. This is the canonical path because OpenCode emits a real model switch event.

For direct text input such as `/model opencode-go/deepseek-v4-pro`, OpenCode 1.15.10 does not emit a native model switch event; it records the text as a normal user message. The plugin therefore treats that text shape as a handoff trigger, injects context, filters the command out of turnLog persistence, and ignores stale model events that OpenCode may emit afterward.

## TurnLog approach

The plugin listens to `message.updated` (role=user) for turn creation and `session.idle` for persistence. TurnLog is a session-local bounded cache — git state remains the durable source of truth.

## Open questions

1. Where exactly in `message.updated` is the user message text (for turnLog `request` field)?
2. Can OpenCode expose a true direct model command event for `/model provider/model`, or is text-event detection the only plugin-level path?

## Resolved

1. Event after native `/models` selection → `session.next.model.switched` (verified in OpenCode 1.15.10)
2. Event payload includes previous/new model info → yes, via `properties.model.{id,providerID}`
3. How to get active TUI session id → `session.created` / `message.updated` / `session.idle`
4. Model state sync → `session.next.model.switched` hook auto-injects context; no manual model state management needed
5. TurnLog approach → `message.updated` (role=user) for turn creation, `session.idle` for persistence
6. Direct `/model provider/model` text input → no native switch event in OpenCode 1.15.10; detect through text events as fallback
