# Implementation Status

This document summarizes what `local-code-opencode-plugin` currently implements, what has been verified, and what remains before a stable release.

## Summary

The repository now contains a working native OpenCode plugin that injects git-based handoff context when the user switches models in the OpenCode TUI.

The implementation is approximately **92-95% complete** for the current release target.

## Goal

When a user switches models inside OpenCode, the next model should receive context based on **git working tree state, status, diff, and log**, rather than relying only on the chat transcript.

Target flow:

```text
User works normally in the OpenCode TUI
  |
Model switch occurs through the native /models picker
or direct /model provider/model text is entered as a fallback trigger
  |
Plugin collects current repo/workspace state:
  - git status --short
  - git diff --stat
  - git log -10 --oneline
  - recent per-turn file changes
  |
Plugin injects a noReply context-only message into the current session
  |
The next model continues using git state as the primary handoff context
```

Release principles:

- Preserve the default OpenCode TUI experience.
- Do not make transcript or a durable handoff file the source of truth.
- Treat git state as the durable source of truth.
- Intervene only at model switch boundaries.
- Include a safety reminder against unapproved `push`, `merge`, `deploy`, `publish`, and `release`.
- Keep turn history as a bounded session-local cache.

## Implemented

### 1. Git Context Core

Completion: **95%**

Files:

- `src/context.js`
- `src/handoff.js`
- `bin/lc-opencode-context.js`
- `test/context.test.js`
- `test/handoff.test.js`

Implemented behavior:

- Detects whether the current working directory is a git repository.
- Detects a multi-repo workspace when two or more immediate child directories have their own `.git` entry.
- Detects a single child repository when the root is not itself a git repository.
- Avoids treating ordinary child directories inside a repository as separate workspace repositories.
- Collects per-repo status, diff stat, and recent commits.
- Captures before/after git diff snapshots around a user turn.
- Records staged, unstaged, and untracked file changes as per-turn diff stats.
- Excludes plugin internal state under `.opencode/local-code/`.
- Renders a local-code style model handoff prompt.
- Renders a bounded turn-log window: first 3 turns plus latest 7 turns.

CLI example:

```bash
node bin/lc-opencode-context.js \
  --cwd . \
  --previous-model openai/gpt-5-codex \
  --next-model anthropic/claude-sonnet-4-5
```

Installed binary example:

```bash
lc-opencode-context --cwd . --next-model anthropic/claude-sonnet-4-5
```

### 2. Native OpenCode Plugin

Completion: **92-95%**

Files:

- `src/plugin.js` (npm package entry)
- `.opencode/plugins/local-code-plugin.js` (local development copy used by real TUI smoke tests)
- `test/plugin.test.js`

Implemented behavior:

- Exports the `LocalCodeOpenCodePlugin` factory.
- Tracks session, model, and agent state through OpenCode events:
  - `session.created`
  - `session.updated`
  - `session.next.model.switched`
  - `session.next.agent.switched`
  - `message.part.updated`
  - `message.updated`
  - `session.idle`
- Injects context with `client.session.prompt({ noReply: true, parts: [...] })`.
- Automatically injects context on native `/models` picker switches.
- Treats direct `/model provider/model` text input as a fallback handoff trigger.
- Filters injected handoff messages and direct model commands out of turn-log persistence.
- Guards against stale session or assistant model events that can arrive after the direct command fallback path.
- Persists turn history to `.opencode/local-code/turns.json` with a maximum of 50 entries.
- Backs up malformed `turns.json` files before starting with a fresh turn log.
- Recovers a deferred model-switch prompt from OpenCode prompt history when text events are missed or interleaved.
- Skips injection when no repositories are found or all repositories are clean.

### 3. Turn Tracking

Completion: **92-95%**

Current behavior:

- `message.updated` with `role=user` creates a draft turn and captures a before snapshot.
- `message.part.updated` attaches user text to the matching message id.
- `session.idle` captures an after snapshot, compares before/after state, and finalizes the turn.
- `info.summary.diffs` remains as a fallback when snapshot comparison has no result.
- Empty no-op turns, injected handoff messages, and direct model commands are filtered out.
- Stale concurrent plugin instances merge turn history instead of shrinking it.

Turn shape:

```js
{
  messageID,
  model,
  agent,
  request,
  diffStats,
  createdAt
}
```

## Verified Tests

Automated checks:

```bash
npm test
npm run check
node --check .opencode/plugins/local-code-plugin.js
node bin/lc-opencode-context.js
env NPM_CONFIG_CACHE=/private/tmp/lc-npm-cache npm pack --dry-run
```

Current expected result:

```text
npm test      # 39 tests passing
npm run check # syntax check passing
npm pack      # package contains runtime source, CLI, docs, license, and README
```

Real OpenCode TUI smoke coverage:

- Fresh XDG data/config/cache/state directories.
- Fresh temporary git workspace.
- Malformed `.opencode/local-code/turns.json` recovery and backup.
- First prompt captured under the initial model.
- Native `/models` picker switch.
- Prompt sent immediately after model switch.
- Handoff injection confirmed in debug logs.
- Injected handoff turn ignored.
- Prompt-history fallback verified when text events are missed or interleaved.
- Multiple model switches including A -> B -> A style flows verified in earlier smoke rounds.

## Remaining Work

Release blockers: **none known after the latest smoke pass**.

Non-blocking follow-up candidates:

1. Optional per-project config
   - Example path: `.opencode/local-code.json`
   - Possible options: turn-log max size, render window, repository detection behavior
2. Upstream OpenCode native direct-model-command event
   - If OpenCode exposes a true event for direct `/model provider/model` in the future, the fallback text-event path can be replaced or simplified.
3. Broader packaging polish
   - Add release notes/changelog when preparing the public registry entry.

## Local Test Guide

Clone and install:

```bash
git clone https://github.com/wi202im/local-code-opencode-plugin.git
cd local-code-opencode-plugin
npm install
```

Run checks:

```bash
npm test
npm run check
```

Inspect CLI output:

```bash
node bin/lc-opencode-context.js --cwd . --next-model opencode-go/deepseek-v4-pro
```

The output should include:

- `[Local-code model handoff]`
- Current repository name
- `git status --short`
- `git diff --stat`
- `git log -10 --oneline`
- Safety language against unapproved push, merge, deploy, publish, or release

Manual OpenCode test:

1. Register the plugin in OpenCode.
2. Start OpenCode in a git repository.
3. Make a small tracked or untracked file change.
4. Switch models with the native `/models` picker.
5. Confirm that the next model receives git handoff context.
6. Enter `/model provider/model` as direct text and confirm that it triggers handoff context without persisting the command as a work turn.

## Conclusion

The plugin is ready for release preparation. The main feature path is implemented, automated tests pass, real TUI smoke tests have covered the high-risk model-switch flows, and packaging has been narrowed to release-appropriate files.
