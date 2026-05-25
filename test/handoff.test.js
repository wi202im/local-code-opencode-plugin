import test from "node:test";
import assert from "node:assert/strict";
import { renderModelHandoffPrompt } from "../src/handoff.js";

function makePayload(overrides = {}) {
  return {
    kind: "local-code-opencode-model-handoff",
    generatedAt: new Date().toISOString(),
    workspaceRoot: "/tmp/test",
    previousModel: "old/test",
    nextModel: "new/test",
    repos: [{ name: "test", path: "/tmp/test" }],
    repoStates: [{
      repo: { name: "test", path: "/tmp/test" },
      status: "M README.md",
      diffStat: "README.md | 2 +-",
      log: "abc1234 init",
    }],
    turnLog: [],
    ...overrides,
  };
}

function makeTurn(i, overrides = {}) {
  return {
    model: "test/model",
    agent: "build",
    request: `turn ${i} request`,
    diffStats: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("renders handoff header, model transition, and git sections", () => {
  const rendered = renderModelHandoffPrompt(makePayload());
  assert.match(rendered, /Local-code model handoff/);
  assert.match(rendered, /Previous model: old\/test/);
  assert.match(rendered, /Next model: new\/test/);
  assert.match(rendered, /git status/);
});

test("handoff shows unknown request when no request text captured", () => {
  const turn = makeTurn(1, { request: undefined });
  const rendered = renderModelHandoffPrompt(makePayload({ turnLog: [turn] }));
  assert.match(rendered, /unknown request/);
});

test("handoff shows captured request text", () => {
  const turn = makeTurn(1, { request: "README 업데이트해줘" });
  const rendered = renderModelHandoffPrompt(makePayload({ turnLog: [turn] }));
  assert.match(rendered, /README 업데이트해줘/);
});

test("handoff sliding window for <= 10 turns shows all", () => {
  const turns = Array.from({ length: 8 }, (_, i) => makeTurn(i + 1));
  const rendered = renderModelHandoffPrompt(makePayload({ turnLog: turns }));
  assert.match(rendered, /8 total/);
  assert.doesNotMatch(rendered, /middle.*omitted/);
});

test("handoff sliding window for > 10 turns shows first 3 + last 7", () => {
  const turns = Array.from({ length: 20 }, (_, i) => makeTurn(i + 1));
  const rendered = renderModelHandoffPrompt(makePayload({ turnLog: turns }));
  assert.match(rendered, /first 3 \+ latest 7/);
  assert.match(rendered, /10 middle turns omitted/);
});

test("handoff with no repos shows fallback message", () => {
  const rendered = renderModelHandoffPrompt(makePayload({ repos: [], repoStates: [] }));
  assert.match(rendered, /no git repositories found/);
  assert.match(rendered, /Registered repos:/);
});

test("handoff with clean repo shows clean state", () => {
  const rendered = renderModelHandoffPrompt(makePayload({
    repoStates: [{
      repo: { name: "test", path: "/tmp/test" },
      status: "",
      diffStat: "",
      log: "",
    }],
  }));
  assert.match(rendered, /\(clean\)/);
  assert.match(rendered, /\(no diff\)/);
  assert.match(rendered, /\(no commits\)/);
});

test("handoff with multiple repos renders all", () => {
  const rendered = renderModelHandoffPrompt(makePayload({
    repos: [
      { name: "api", path: "/tmp/api" },
      { name: "web", path: "/tmp/web" },
    ],
    repoStates: [
      { repo: { name: "api", path: "/tmp/api" }, status: "M api.js", diffStat: "api.js | 3 +++", log: "abc fix" },
      { repo: { name: "web", path: "/tmp/web" }, status: "M app.js", diffStat: "app.js | 5 +--", log: "def feat" },
    ],
  }));
  assert.match(rendered, /api.*\/tmp\/api/);
  assert.match(rendered, /web.*\/tmp\/web/);
  assert.match(rendered, /api\.js \| 3/);
  assert.match(rendered, /app\.js \| 5/);
});

test("handoff includes safety clause", () => {
  const rendered = renderModelHandoffPrompt(makePayload());
  assert.match(rendered, /push.*merge.*deploy.*publish.*release/);
});

test("handoff tells the next model that the user prompt has priority", () => {
  const rendered = renderModelHandoffPrompt(makePayload());
  assert.match(rendered, /background context/);
  assert.match(rendered, /Do not answer this handoff message directly/);
  assert.match(rendered, /next user message.*follow that user message first/);
  assert.match(rendered, /user message wins/);
});
