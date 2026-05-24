import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildContextPayload, detectWorkspaceRepos } from "../src/context.js";
import { renderModelHandoffPrompt } from "../src/handoff.js";
import { splitModelID } from "../src/profiles.js";

test("detects a single git repo and renders handoff", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lc-opencode-"));
  git(dir, ["init"]);
  await writeFile(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  await writeFile(path.join(dir, "README.md"), "hello\nworld\n");

  const payload = await buildContextPayload({ cwd: dir, previousModel: "old/model", nextModel: "new/model" });
  assert.equal(payload.repos.length, 1);
  assert.equal(payload.previousModel, "old/model");
  assert.equal(payload.nextModel, "new/model");
  assert.match(payload.repoStates[0].diffStat, /README.md/);

  const rendered = renderModelHandoffPrompt(payload);
  assert.match(rendered, /Local-code model handoff/);
  assert.match(rendered, /이전 모델: old\/model/);
  assert.match(rendered, /새 모델: new\/model/);
  assert.match(rendered, /git status/);
});

test("workspace mode prefers two immediate child git repos", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lc-opencode-workspace-"));
  for (const name of ["api", "web"]) {
    const dir = path.join(root, name);
    await mkdir(dir);
    git(dir, ["init"]);
  }
  const repos = await detectWorkspaceRepos(root);
  assert.deepEqual(repos.map((repo) => repo.name), ["api", "web"]);
});

test("detects single child repo when root is not a git repo", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lc-opencode-nongit-"));
  const dir = path.join(root, "myproj");
  await mkdir(dir);
  git(dir, ["init"]);
  const repos = await detectWorkspaceRepos(root);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].name, "myproj");
});

test("does not treat normal child directories of a repo as workspace repos", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lc-opencode-root-"));
  git(root, ["init"]);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "docs"));
  const repos = await detectWorkspaceRepos(root);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].path, root);
});

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

test("handoff shows unknown request when no request text captured", () => {
  const turn = makeTurn(1, { request: undefined });
  const payload = makePayload({ turnLog: [turn] });
  const rendered = renderModelHandoffPrompt(payload);
  assert.match(rendered, /unknown request/);
});

test("handoff shows captured request text", () => {
  const turn = makeTurn(1, { request: "README 업데이트해줘" });
  const payload = makePayload({ turnLog: [turn] });
  const rendered = renderModelHandoffPrompt(payload);
  assert.match(rendered, /README 업데이트해줘/);
});

test("handoff sliding window for <= 10 turns shows all", () => {
  const turns = Array.from({ length: 8 }, (_, i) => makeTurn(i + 1));
  const payload = makePayload({ turnLog: turns });
  const rendered = renderModelHandoffPrompt(payload);
  assert.match(rendered, /총 8개/);
  assert.doesNotMatch(rendered, /중간.*생략/);
});

test("handoff sliding window for > 10 turns shows first 3 + last 7", () => {
  const turns = Array.from({ length: 20 }, (_, i) => makeTurn(i + 1));
  const payload = makePayload({ turnLog: turns });
  const rendered = renderModelHandoffPrompt(payload);
  assert.match(rendered, /처음 3 \+ 최근 7/);
  assert.match(rendered, /중간 10개 turn 생략/);
});

test("handoff with no repos shows fallback message", () => {
  const payload = makePayload({ repos: [], repoStates: [] });
  const rendered = renderModelHandoffPrompt(payload);
  assert.match(rendered, /git repo를 찾지 못했습니다/);
  assert.match(rendered, /등록된 repos:/);
});

test("handoff with clean repo shows clean state", () => {
  const payload = makePayload({
    repoStates: [{
      repo: { name: "test", path: "/tmp/test" },
      status: "",
      diffStat: "",
      log: "",
    }],
  });
  const rendered = renderModelHandoffPrompt(payload);
  assert.match(rendered, /\(clean\)/);
  assert.match(rendered, /\(no diff\)/);
  assert.match(rendered, /\(no commits\)/);
});

test("handoff with multiple repos renders all", () => {
  const payload = makePayload({
    repos: [
      { name: "api", path: "/tmp/api" },
      { name: "web", path: "/tmp/web" },
    ],
    repoStates: [
      { repo: { name: "api", path: "/tmp/api" }, status: "M api.js", diffStat: "api.js | 3 +++", log: "abc fix" },
      { repo: { name: "web", path: "/tmp/web" }, status: "M app.js", diffStat: "app.js | 5 +--", log: "def feat" },
    ],
  });
  const rendered = renderModelHandoffPrompt(payload);
  assert.match(rendered, /api.*\/tmp\/api/);
  assert.match(rendered, /web.*\/tmp\/web/);
  assert.match(rendered, /api\.js \| 3/);
  assert.match(rendered, /app\.js \| 5/);
});

test("splitModelID splits provider/model", () => {
  assert.deepEqual(splitModelID("openai/gpt-5.3-codex"), { providerID: "openai", modelID: "gpt-5.3-codex" });
  assert.deepEqual(splitModelID("opencode-go/deepseek-v4-pro"), { providerID: "opencode-go", modelID: "deepseek-v4-pro" });
});

test("splitModelID handles no slash", () => {
  assert.deepEqual(splitModelID("gpt-5"), { providerID: "", modelID: "gpt-5" });
});

test("handoff includes safety clause", () => {
  const payload = makePayload();
  const rendered = renderModelHandoffPrompt(payload);
  assert.match(rendered, /push.*merge.*deploy.*publish.*release/);
});

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
