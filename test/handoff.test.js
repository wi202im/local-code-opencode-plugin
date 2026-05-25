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
  assert.match(rendered, /이전 모델: old\/test/);
  assert.match(rendered, /새 모델: new\/test/);
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
  assert.match(rendered, /총 8개/);
  assert.doesNotMatch(rendered, /중간.*생략/);
});

test("handoff sliding window for > 10 turns shows first 3 + last 7", () => {
  const turns = Array.from({ length: 20 }, (_, i) => makeTurn(i + 1));
  const rendered = renderModelHandoffPrompt(makePayload({ turnLog: turns }));
  assert.match(rendered, /처음 3 \+ 최근 7/);
  assert.match(rendered, /중간 10개 turn 생략/);
});

test("handoff with no repos shows fallback message", () => {
  const rendered = renderModelHandoffPrompt(makePayload({ repos: [], repoStates: [] }));
  assert.match(rendered, /git repo를 찾지 못했습니다/);
  assert.match(rendered, /등록된 repos:/);
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
  assert.match(rendered, /배경 컨텍스트/);
  assert.match(rendered, /handoff 자체에 답하지 마세요/);
  assert.match(rendered, /다음 사용자 메시지.*최우선/);
  assert.match(rendered, /사용자 메시지가 우선/);
});
