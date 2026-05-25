import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildContextPayload, collectDiffSnapshot, detectWorkspaceRepos, diffStatsBetweenSnapshots } from "../src/context.js";
import { git, initRepo, initWorkspace, makeTempDir } from "../test-support/helpers.js";

test("detects a single git repo and collects repo state", async () => {
  const dir = await makeTempDir("lc-opencode-");
  await initRepo(dir);
  await writeFile(path.join(dir, "README.md"), "hello\nworld\n");

  const payload = await buildContextPayload({ cwd: dir, previousModel: "old/model", nextModel: "new/model" });
  assert.equal(payload.repos.length, 1);
  assert.equal(payload.previousModel, "old/model");
  assert.equal(payload.nextModel, "new/model");
  assert.match(payload.repoStates[0].diffStat, /README.md/);
});

test("repo state ignores local-code internal state files", async () => {
  const dir = await makeTempDir("lc-opencode-internal-state-");
  await initRepo(dir);
  await writeFile(path.join(dir, "README.md"), "hello\nworld\n");
  await mkdir(path.join(dir, ".opencode/local-code"), { recursive: true });
  await writeFile(path.join(dir, ".opencode/local-code/turns.json"), "[]\n");

  const payload = await buildContextPayload({ cwd: dir, previousModel: "old/model", nextModel: "new/model" });
  assert.match(payload.repoStates[0].status, /README.md/);
  assert.doesNotMatch(payload.repoStates[0].status, /\.opencode\/local-code/);
  assert.match(payload.repoStates[0].diffStat, /README.md/);
  assert.doesNotMatch(payload.repoStates[0].diffStat, /\.opencode\/local-code/);
});

test("workspace mode prefers two immediate child git repos", async () => {
  const root = await makeTempDir("lc-opencode-workspace-");
  await initWorkspace(root, ["api", "web"]);

  const repos = await detectWorkspaceRepos(root);
  assert.deepEqual(repos.map((repo) => repo.name), ["api", "web"]);
});

test("detects single child repo when root is not a git repo", async () => {
  const root = await makeTempDir("lc-opencode-nongit-");
  const dir = path.join(root, "myproj");
  await mkdir(dir);
  await initRepo(dir);

  const repos = await detectWorkspaceRepos(root);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].name, "myproj");
});

test("does not treat normal child directories of a repo as workspace repos", async () => {
  const root = await makeTempDir("lc-opencode-root-");
  await initRepo(root);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "docs"));

  const repos = await detectWorkspaceRepos(root);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].path, root);
});

test("diff snapshots capture staged, changed, and untracked files", async () => {
  const dir = await makeTempDir("lc-opencode-snapshot-");
  await initRepo(dir);
  await writeFile(path.join(dir, "draft.md"), "before\n");

  const before = await collectDiffSnapshot({ cwd: dir });
  await writeFile(path.join(dir, "README.md"), "hello\nworld\n");
  git(dir, ["add", "README.md"]);
  await writeFile(path.join(dir, "draft.md"), "after\n");
  await writeFile(path.join(dir, "notes.md"), "new file\n");
  const after = await collectDiffSnapshot({ cwd: dir });

  const stats = diffStatsBetweenSnapshots(before, after);
  assert.deepEqual(stats.map((entry) => entry.path).sort(), ["README.md", "draft.md", "notes.md"]);
  assert.match(stats.find((entry) => entry.path === "README.md").diffStat, /README\.md/);
  assert.equal(stats.find((entry) => entry.path === "draft.md").diffStat, "(untracked file)");
  assert.equal(stats.find((entry) => entry.path === "notes.md").diffStat, "(untracked file)");
});

test("diff snapshots label files with repo name in multi-repo workspaces", async () => {
  const root = await makeTempDir("lc-opencode-snapshot-workspace-");
  await initWorkspace(root, ["api", "web"]);

  const before = await collectDiffSnapshot({ cwd: root });
  await writeFile(path.join(root, "api", "README.md"), "api\nchanged\n");
  await writeFile(path.join(root, "web", "notes.md"), "new file\n");
  const after = await collectDiffSnapshot({ cwd: root });

  const stats = diffStatsBetweenSnapshots(before, after);
  assert.deepEqual(stats.map((entry) => entry.path).sort(), ["api/README.md", "web/notes.md"]);
});
