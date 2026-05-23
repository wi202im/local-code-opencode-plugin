# OpenCode Plugin Spikes

## Spike 1 — Event payload map

Run OpenCode with:

```bash
LOCAL_CODE_OPENCODE_DEBUG=1 opencode
```

Actions to perform:

1. Send a normal message.
2. Wait for session idle.
3. Run `/models` and select another model.
4. Run `/lc-model sonnet`.
5. Run a custom command with `model:` frontmatter.

Record:

- event type
- payload keys
- session id location
- model fields, if present

## Spike 2 — noReply context injection

Goal: verify context-only injection affects the next answer.

Candidate call:

```ts
await client.session.prompt({
  path: { id: sessionID },
  body: {
    noReply: true,
    parts: [{ type: "text", text: "Remember marker LC_CONTEXT_SPIKE_OK" }],
  },
})
```

Then ask in TUI:

```text
What marker did the plugin inject?
```

Expected: model mentions `LC_CONTEXT_SPIKE_OK`.

## Spike 3 — model state update

Try in order:

1. `client.config.update({ body: { model } })`
2. `client.session.prompt({ body: { model, parts } })`
3. command frontmatter `model:`
4. native `/models` event-driven injection

Success criteria:

- TUI status shows the new model, or
- next assistant response definitely uses the requested model, and
- context injection survives the switch.

## Spike 4 — turnLog reconstruction

Candidate tracking:

- pre snapshot on user `message.updated`
- post diff on `session.idle`
- fallback to accumulated git state if snapshot is missing

Turn record shape:

```js
{
  request,
  model,
  agent,
  diffStats,
  createdAt
}
```

Keep cache session-local and bounded. Do not make transcript the durable source of truth.
