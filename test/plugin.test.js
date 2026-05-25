import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalCodeOpenCodePlugin } from "../src/plugin.js";
import { initRepo, makeTempDir } from "../test-support/helpers.js";

function makeClient(prompts = []) {
  return {
    session: {
      prompt: async (options) => {
        prompts.push(options);
      },
    },
  };
}

async function makePluginRepo(prefix) {
  const dir = await makeTempDir(prefix);
  await initRepo(dir);
  return dir;
}

async function sendSessionCreated(plugin) {
  await plugin.event({ event: { type: "session.created", properties: { info: { id: "ses_test" } } } });
}

async function sendInitialModel(plugin) {
  await plugin.event({ event: { type: "session.updated", properties: { info: { model: { providerID: "openai", modelID: "gpt-5.5" } } } } });
}

async function sendUserTurn(plugin, { id, text, providerID, modelID }) {
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id,
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID, modelID },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: `${id}_part`,
          sessionID: "ses_test",
          messageID: id,
          type: "text",
          text,
        },
      },
    },
  });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });
}

async function switchModel(plugin, providerID, id) {
  await plugin.event({
    event: {
      type: "session.next.model.switched",
      properties: {
        sessionID: "ses_test",
        model: { providerID, id },
      },
    },
  });
  await plugin.event({
    event: {
      type: "session.updated",
      properties: {
        info: { model: { providerID, modelID: id } },
      },
    },
  });
}

test("plugin handles direct /model command without persisting it as a turn", async () => {
  const dir = await makePluginRepo("lc-opencode-direct-");
  await writeFile(path.join(dir, "README.md"), "hello\nworld\n");

  const prompts = [];
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient(prompts) });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_direct",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_direct",
          sessionID: "ses_test",
          messageID: "msg_direct",
          type: "text",
          text: "/model opencode-go/deepseek-v4-pro",
        },
      },
    },
  });

  await plugin.event({ event: { type: "session.updated", properties: { info: { model: { providerID: "openai", modelID: "gpt-5.5" } } } } });
  await plugin.event({ event: { type: "message.updated", properties: { info: { id: "assistant_old", role: "assistant", providerID: "openai", modelID: "gpt-5.5" } } } });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  assert.equal(prompts.length, 1);
  const handoff = prompts[0].body.parts[0].text;
  assert.match(handoff, /새 모델: opencode-go\/deepseek-v4-pro/);
  assert.match(handoff, /README\.md/);

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.equal(turns.some((turn) => turn.request?.includes("/model opencode-go/deepseek-v4-pro")), false);
});

test("plugin finalizes turn diff stats from git snapshot changes", async () => {
  const dir = await makePluginRepo("lc-opencode-turn-diff-");
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient() });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_turn",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_turn",
          sessionID: "ses_test",
          messageID: "msg_turn",
          type: "text",
          text: "README와 notes를 업데이트해줘",
        },
      },
    },
  });

  await writeFile(path.join(dir, "README.md"), "hello\nworld\n");
  await writeFile(path.join(dir, "notes.md"), "new file\n");
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].request, "README와 notes를 업데이트해줘");
  assert.deepEqual(turns[0].diffStats.map((entry) => entry.path).sort(), ["README.md", "notes.md"]);
});

test("plugin updates repeated user message events without duplicating turns", async () => {
  const dir = await makePluginRepo("lc-opencode-repeat-user-");
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient() });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  const userEvent = {
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_repeat",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      },
    },
  };

  await plugin.event(userEvent);
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_repeat",
          sessionID: "ses_test",
          messageID: "msg_repeat",
          type: "text",
          text: "같은 user message.updated가 다시 와도 한 turn만 남겨줘",
        },
      },
    },
  });
  await plugin.event(userEvent);
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].request, "같은 user message.updated가 다시 와도 한 turn만 남겨줘");
});

test("plugin ignores repeated user message events after idle finalization", async () => {
  const dir = await makePluginRepo("lc-opencode-repeat-after-idle-");
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient() });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  const userEvent = {
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_repeat_finalized",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      },
    },
  };

  await plugin.event(userEvent);
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_repeat_finalized",
          sessionID: "ses_test",
          messageID: "msg_repeat_finalized",
          type: "text",
          text: "idle 이후 같은 user message.updated가 다시 와도 한 turn만 남겨줘",
        },
      },
    },
  });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });
  await plugin.event(userEvent);
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].request, "idle 이후 같은 user message.updated가 다시 와도 한 turn만 남겨줘");
});

test("plugin does not let stale instances shrink the persisted turn log", async () => {
  const dir = await makePluginRepo("lc-opencode-stale-instance-");

  const stalePlugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient() });
  await sendSessionCreated(stalePlugin);
  await sendInitialModel(stalePlugin);
  await sendUserTurn(stalePlugin, {
    id: "msg_stale_1",
    text: "첫 번째 요청",
    providerID: "openai",
    modelID: "gpt-5.5",
  });

  const currentPlugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient() });
  await sendSessionCreated(currentPlugin);
  await sendInitialModel(currentPlugin);
  await sendUserTurn(currentPlugin, {
    id: "msg_stale_2",
    text: "두 번째 요청",
    providerID: "opencode",
    modelID: "big-pickle",
  });

  await stalePlugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.deepEqual(turns.map((turn) => turn.request), ["첫 번째 요청", "두 번째 요청"]);
});

test("plugin merges stale same-length saves instead of overwriting newer turns", async () => {
  const dir = await makePluginRepo("lc-opencode-stale-same-length-");

  const stalePlugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient() });
  await sendSessionCreated(stalePlugin);
  await sendInitialModel(stalePlugin);
  await sendUserTurn(stalePlugin, {
    id: "msg_old_same_length",
    text: "오래된 단일 요청",
    providerID: "openai",
    modelID: "gpt-5.5",
  });

  await writeFile(path.join(dir, ".opencode/local-code/turns.json"), JSON.stringify([{
    messageID: "msg_new_same_length",
    model: "opencode/big-pickle",
    agent: "build",
    request: "더 최신 단일 요청",
    diffStats: [],
    createdAt: new Date().toISOString(),
  }], null, 2));

  await stalePlugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.deepEqual(turns.map((turn) => turn.request), ["더 최신 단일 요청", "오래된 단일 요청"]);
});

test("plugin drops empty no-op pending turns", async () => {
  const dir = await makePluginRepo("lc-opencode-empty-turn-");
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient() });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_empty",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      },
    },
  });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.equal(turns.length, 0);
});

test("plugin does not persist empty injected handoff placeholders", async () => {
  const dir = await makePluginRepo("lc-opencode-empty-handoff-");
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient() });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_handoff_placeholder",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_after_handoff",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_after_handoff",
          sessionID: "ses_test",
          messageID: "msg_after_handoff",
          type: "text",
          text: "handoff 직후 사용자 프롬프트",
        },
      },
    },
  });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].request, "handoff 직후 사용자 프롬프트");
});

test("plugin does not remove a real turn when a late handoff part reuses its message id", async () => {
  const dir = await makePluginRepo("lc-opencode-late-handoff-part-");
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient() });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_real_then_handoff",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "opencode", modelID: "big-pickle" },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_real",
          sessionID: "ses_test",
          messageID: "msg_real_then_handoff",
          type: "text",
          text: "실제 사용자 요청",
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_handoff_late",
          sessionID: "ses_test",
          messageID: "msg_real_then_handoff",
          type: "text",
          text: "[Local-code model handoff]\n늦게 도착한 handoff part",
        },
      },
    },
  });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].request, "실제 사용자 요청");
});

test("plugin ignores post-idle handoff placeholders without dropping the finalized turn", async () => {
  const dir = await makePluginRepo("lc-opencode-post-idle-handoff-");
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient() });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await sendUserTurn(plugin, {
    id: "msg_before_handoff",
    text: "handoff 전에 완료된 실제 요청",
    providerID: "opencode",
    modelID: "big-pickle",
  });
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_handoff_after_idle",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "opencode", modelID: "big-pickle" },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_handoff_after_idle",
          sessionID: "ses_test",
          messageID: "msg_handoff_after_idle",
          type: "text",
          text: "[Local-code model handoff]\nidle 이후 도착한 handoff placeholder",
        },
      },
    },
  });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.deepEqual(turns.map((turn) => turn.request), ["handoff 전에 완료된 실제 요청"]);
});

test("plugin ignores local-code internal summary diffs", async () => {
  const dir = await makePluginRepo("lc-opencode-internal-summary-");
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient() });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_internal_summary",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_internal_summary",
          sessionID: "ses_test",
          messageID: "msg_internal_summary",
          type: "text",
          text: "내부 상태 파일은 diff로 보지 마",
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_internal_summary",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
          summary: {
            diffs: [
              { file: ".opencode/local-code/turns.json", patch: "internal" },
            ],
          },
        },
      },
    },
  });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].request, "내부 상태 파일은 diff로 보지 마");
  assert.deepEqual(turns[0].diffStats, []);
});

test("plugin does not let direct /model stale guard block a real later model switch", async () => {
  const dir = await makePluginRepo("lc-opencode-direct-switch-");
  await writeFile(path.join(dir, "README.md"), "hello\nworld\n");

  const prompts = [];
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient(prompts) });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_direct",
          sessionID: "ses_test",
          messageID: "msg_direct",
          type: "text",
          text: "/model opencode-go/deepseek-v4-pro",
        },
      },
    },
  });
  await plugin.event({ event: { type: "session.updated", properties: { info: { model: { providerID: "openai", modelID: "gpt-5.5" } } } } });
  await plugin.event({
    event: {
      type: "session.next.model.switched",
      properties: {
        sessionID: "ses_test",
        model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      },
    },
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[0].body.parts[0].text, /새 모델: opencode-go\/deepseek-v4-pro/);
  assert.match(prompts[1].body.parts[0].text, /새 모델: anthropic\/claude-sonnet-4-5/);
});

test("plugin keeps direct /model stale guard through empty injected placeholders", async () => {
  const dir = await makePluginRepo("lc-opencode-direct-empty-placeholder-");
  await writeFile(path.join(dir, "README.md"), "hello\nworld\n");

  const prompts = [];
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient(prompts) });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_direct",
          sessionID: "ses_test",
          messageID: "msg_direct",
          type: "text",
          text: "/model opencode-go/deepseek-v4-pro",
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_injected_placeholder",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      },
    },
  });
  await plugin.event({ event: { type: "session.updated", properties: { info: { model: { providerID: "openai", modelID: "gpt-5.5" } } } } });

  assert.equal(prompts.length, 1);
  assert.match(prompts[0].body.parts[0].text, /새 모델: opencode-go\/deepseek-v4-pro/);
});

test("plugin clears direct /model stale guard when real user text arrives late", async () => {
  const dir = await makePluginRepo("lc-opencode-direct-late-text-");
  await writeFile(path.join(dir, "README.md"), "hello\nworld\n");

  const prompts = [];
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient(prompts) });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_direct",
          sessionID: "ses_test",
          messageID: "msg_direct",
          type: "text",
          text: "/model opencode-go/deepseek-v4-pro",
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_real",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_real",
          sessionID: "ses_test",
          messageID: "msg_real",
          type: "text",
          text: "Reply exactly: direct-after-ok",
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_real",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.5" },
        },
      },
    },
  });
  await plugin.event({ event: { type: "session.updated", properties: { info: { model: { providerID: "openai", modelID: "gpt-5.5" } } } } });
  await plugin.event({
    event: {
      type: "session.next.model.switched",
      properties: {
        sessionID: "ses_test",
        model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      },
    },
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[0].body.parts[0].text, /새 모델: opencode-go\/deepseek-v4-pro/);
  assert.match(prompts[1].body.parts[0].text, /새 모델: anthropic\/claude-sonnet-4-5/);
});

test("plugin preserves context across A to B to A to B model switches", async () => {
  const dir = await makePluginRepo("lc-opencode-model-roundtrip-");
  await writeFile(path.join(dir, "README.md"), "hello\nroundtrip dirty state\n");

  const prompts = [];
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient(prompts) });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await sendUserTurn(plugin, {
    id: "msg_a1",
    text: "A 모델에서 첫 작업",
    providerID: "openai",
    modelID: "gpt-5.5",
  });

  await switchModel(plugin, "anthropic", "claude-sonnet-4-5");
  await sendUserTurn(plugin, {
    id: "msg_b1",
    text: "B 모델에서 이어서 작업",
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
  });

  await switchModel(plugin, "openai", "gpt-5.5");
  await sendUserTurn(plugin, {
    id: "msg_a2",
    text: "A 모델로 돌아와 작업",
    providerID: "openai",
    modelID: "gpt-5.5",
  });

  await switchModel(plugin, "anthropic", "claude-sonnet-4-5");
  await sendUserTurn(plugin, {
    id: "msg_b2",
    text: "B 모델로 다시 넘어가 작업",
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
  });

  assert.equal(prompts.length, 3);
  assert.match(prompts[0].body.parts[0].text, /이전 모델: openai\/gpt-5\.5/);
  assert.match(prompts[0].body.parts[0].text, /새 모델: anthropic\/claude-sonnet-4-5/);
  assert.match(prompts[1].body.parts[0].text, /이전 모델: anthropic\/claude-sonnet-4-5/);
  assert.match(prompts[1].body.parts[0].text, /새 모델: openai\/gpt-5\.5/);
  assert.match(prompts[2].body.parts[0].text, /이전 모델: openai\/gpt-5\.5/);
  assert.match(prompts[2].body.parts[0].text, /새 모델: anthropic\/claude-sonnet-4-5/);

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.deepEqual(turns.map((turn) => turn.model), [
    "openai/gpt-5.5",
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-5.5",
    "anthropic/claude-sonnet-4-5",
  ]);
  assert.deepEqual(turns.map((turn) => turn.request), [
    "A 모델에서 첫 작업",
    "B 모델에서 이어서 작업",
    "A 모델로 돌아와 작업",
    "B 모델로 다시 넘어가 작업",
  ]);
});

test("plugin preserves model-switch user prompt when injected handoff placeholder interleaves before text part", async () => {
  const dir = await makePluginRepo("lc-opencode-interleaved-handoff-");
  await writeFile(path.join(dir, "README.md"), "hello\ninterleaved dirty state\n");

  const prompts = [];
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient(prompts) });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await sendUserTurn(plugin, {
    id: "msg_a1",
    text: "A 모델에서 첫 작업",
    providerID: "openai",
    modelID: "gpt-5.5",
  });

  await switchModel(plugin, "anthropic", "claude-sonnet-4-5");
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_b1",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_handoff",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_handoff",
          sessionID: "ses_test",
          messageID: "msg_handoff",
          type: "text",
          text: "[Local-code model handoff]\nbackground only",
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_b1",
          sessionID: "ses_test",
          messageID: "msg_b1",
          type: "text",
          text: "B 모델 전환 직후 사용자 작업",
        },
      },
    },
  });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.deepEqual(turns.map((turn) => turn.request), [
    "A 모델에서 첫 작업",
    "B 모델 전환 직후 사용자 작업",
  ]);
  assert.equal(turns[1].model, "anthropic/claude-sonnet-4-5");
  assert.equal(prompts.length, 1);
});

test("plugin preserves deferred model-switch user prompt when text returns on message.updated parts", async () => {
  const dir = await makePluginRepo("lc-opencode-interleaved-message-parts-");
  await writeFile(path.join(dir, "README.md"), "hello\ninterleaved message parts\n");

  const prompts = [];
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient(prompts) });

  await sendSessionCreated(plugin);
  await sendInitialModel(plugin);
  await sendUserTurn(plugin, {
    id: "msg_a1",
    text: "A 모델에서 첫 작업",
    providerID: "openai",
    modelID: "gpt-5.5",
  });

  await switchModel(plugin, "anthropic", "claude-sonnet-4-5");
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_b1",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_handoff",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_handoff",
          sessionID: "ses_test",
          messageID: "msg_handoff",
          type: "text",
          text: "[Local-code model handoff]\nbackground only",
        },
      },
    },
  });
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_b1",
          sessionID: "ses_test",
          role: "user",
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          parts: [{ type: "text", text: "B 모델 message.updated parts 작업" }],
        },
      },
    },
  });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

  const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
  assert.deepEqual(turns.map((turn) => turn.request), [
    "A 모델에서 첫 작업",
    "B 모델 message.updated parts 작업",
  ]);
  assert.equal(turns[1].model, "anthropic/claude-sonnet-4-5");
});

test("plugin recovers deferred model-switch prompt from OpenCode prompt history when no text event follows", async () => {
  const dir = await makePluginRepo("lc-opencode-prompt-history-recover-");
  const stateHome = await makeTempDir("lc-opencode-state-");
  await mkdir(path.join(stateHome, "opencode"), { recursive: true });
  await writeFile(path.join(dir, "README.md"), "hello\nprompt history fallback\n");

  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    const prompts = [];
    const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient(prompts) });

    await sendSessionCreated(plugin);
    await sendInitialModel(plugin);
    await sendUserTurn(plugin, {
      id: "msg_a1",
      text: "A 모델에서 첫 작업",
      providerID: "openai",
      modelID: "gpt-5.5",
    });

    await switchModel(plugin, "anthropic", "claude-sonnet-4-5");
    await plugin.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_b1",
            sessionID: "ses_test",
            role: "user",
            agent: "build",
            model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          },
        },
      },
    });
    await plugin.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_handoff",
            sessionID: "ses_test",
            role: "user",
            agent: "build",
            model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          },
        },
      },
    });
    await plugin.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_handoff",
            sessionID: "ses_test",
            messageID: "msg_handoff",
            type: "text",
            text: "[Local-code model handoff]\nbackground only",
          },
        },
      },
    });
    await writeFile(
      path.join(stateHome, "opencode/prompt-history.jsonl"),
      `${JSON.stringify({ input: "B 모델 prompt history 복구 작업", parts: [], mode: "normal" })}\n`,
    );
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } });

    const turns = JSON.parse(await readFile(path.join(dir, ".opencode/local-code/turns.json"), "utf-8"));
    assert.deepEqual(turns.map((turn) => turn.request), [
      "A 모델에서 첫 작업",
      "B 모델 prompt history 복구 작업",
    ]);
    assert.equal(turns[1].model, "anthropic/claude-sonnet-4-5");
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
  }
});

test("plugin injects on continued-session model switch using event sessionID", async () => {
  const dir = await makePluginRepo("lc-opencode-continued-switch-");
  await mkdir(path.join(dir, ".opencode/local-code"), { recursive: true });
  await writeFile(path.join(dir, ".opencode/local-code/turns.json"), JSON.stringify([{
    model: "openai/gpt-5.3-codex",
    agent: "build",
    request: "previous turn",
    diffStats: [],
    createdAt: new Date().toISOString(),
  }], null, 2));
  await writeFile(path.join(dir, "README.md"), "hello\ncontinued switch change\n");

  const prompts = [];
  const plugin = await LocalCodeOpenCodePlugin({ directory: dir, client: makeClient(prompts) });

  await plugin.event({
    event: {
      type: "session.next.model.switched",
      properties: {
        sessionID: "ses_continued",
        model: { providerID: "openai", id: "gpt-5.4-mini" },
      },
    },
  });

  assert.equal(prompts.length, 1);
  const handoff = prompts[0].body.parts[0].text;
  assert.match(handoff, /이전 모델: openai\/gpt-5\.3-codex/);
  assert.match(handoff, /새 모델: openai\/gpt-5\.4-mini/);
  assert.deepEqual(prompts[0].path, { id: "ses_continued" });
});
