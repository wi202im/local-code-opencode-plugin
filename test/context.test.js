import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildContextPayload, detectWorkspaceRepos } from "../src/context.js";
import { renderModelHandoffPrompt } from "../src/handoff.js";

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

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
