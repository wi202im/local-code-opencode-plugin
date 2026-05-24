# OpenCode Plugin Spikes

## Spike 1 — Event payload map ✅ VERIFIED (2026-05-23)

Run OpenCode with the `event-spike.js` plugin in `.opencode/plugins/`:

```bash
opencode .
```

The spike plugin writes all events to `.opencode/local-code/spike-logs/`.

### Verified event payload shapes (OpenCode 1.15.10)

| Event | Key fields |
|---|---|
| `session.created` | `properties.info.id` (sessionID), `properties.info.directory`, `properties.info.title` |
| `session.next.model.switched` | `properties.model.id`, `properties.model.providerID`, `properties.model.variant`, `properties.sessionID` |
| `session.next.agent.switched` | `properties.agent`, `properties.sessionID` |
| `command.executed` | `properties.name` (e.g. "lc-deepseek"), `properties.sessionID`, `properties.arguments`, `properties.messageID` |
| `message.updated` | `properties.info.role`, `properties.info.model.{providerID,modelID}`, `properties.info.agent`, `properties.info.id`, `properties.sessionID` |
| `session.idle` | `properties.sessionID` |
| `session.diff` | (fires after file edits, payload large — raw snapshots) |
| `session.status` | session status transitions |
| `session.updated` | session metadata updates |
| `message.part.delta` | streaming text deltas (very high volume, filtered in spike) |
| `tool.execute.before` | `tool` name + args |
| `tool.execute.after` | `tool` name + result |
| `todo.updated` | todo list state |
| `file.watcher.updated` | filesystem change detected |

### Session ID acquisition paths

1. `session.created` → `properties.info.id`
2. `command.executed` → `properties.sessionID`
3. `message.updated` → `properties.sessionID`
4. `session.idle` → `properties.sessionID`

## Spike 2 — noReply context injection

Need to verify in TUI with the updated `src/plugin.js`:

1. Restart OpenCode, run a few turns
2. Execute `/lc-deepseek describe current project state`
3. Verify the new model received the handoff context

The injection call:

```js
await client.session.prompt({
  path: { id: sessionID },
  body: { noReply: true, parts: [{ type: "text", text: handoffPrompt }] },
})
```

## Spike 3 — model state update (NOT needed for custom commands)

Custom command templates use `model:` frontmatter — OpenCode handles model switching automatically. Shell injection (`!\`lc-opencode-context ...\``) injects context into the prompt.

For native `/models` picker switches, the plugin hooks `session.next.model.switched` to auto-inject context without needing to call `client.config.update()`.

Direct text input in the chat box such as `/model opencode-go/deepseek-v4-pro` is not a native OpenCode model switch in 1.15.10. It is observed as a normal user message/part. The plugin handles this as a fallback trigger through `message.part.updated`/`message.updated`, filters the command out of turnLog, and ignores stale model events that can arrive from the current model after the command is submitted.

## Spike 4 — turnLog reconstruction

Verified approach:
- `message.updated` (role=user) → capture model/agent info, append to turnLog
- `message.updated` (role=user) → capture git diff snapshot before assistant/tool work
- `session.idle` → capture git diff snapshot after work, compare, mark turn complete
- TurnLog tracks: `{ request, model, agent, diffStats, createdAt }`
- Sliding window rendering: first 3 + last 7 turns (implemented in `handoff.js`)
- Per-turn git diff stats are now generated from before/after snapshots, including staged/unstaged tracked changes and untracked files, while excluding plugin internal state under `.opencode/local-code/`
