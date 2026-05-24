import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
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
