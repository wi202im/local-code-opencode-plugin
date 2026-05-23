import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function buildContextPayload({ cwd = process.cwd(), previousModel = "unknown", nextModel = "unknown", logLimit = 10 } = {}) {
  const workspaceRoot = path.resolve(cwd);
  const repos = await detectWorkspaceRepos(workspaceRoot);
  const repoStates = await Promise.all(repos.map((repo) => collectRepoState(repo, { logLimit })));
  return {
    kind: "local-code-opencode-model-handoff",
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    previousModel,
    nextModel,
    repos,
    repoStates,
    turnLog: [],
  };
}

export async function detectWorkspaceRepos(root) {
  const childRepos = [];
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    // Important: when root is a git repo, every child directory is technically
    // "inside a work tree". For workspace detection we only want immediate
    // child repos with their own .git entry.
    if (await hasDotGit(full)) {
      childRepos.push({ name: entry.name, path: full });
    }
  }

  if (childRepos.length >= 2) return childRepos.sort((a, b) => a.name.localeCompare(b.name));
  if (await isGitRepo(root)) return [{ name: path.basename(root) || ".", path: root }];
  return [];
}

export async function collectRepoState(repo, { logLimit = 10 } = {}) {
  const [status, diffStat, log] = await Promise.all([
    git(repo.path, ["status", "--short"]),
    git(repo.path, ["diff", "--stat"]),
    git(repo.path, ["log", `-${logLimit}`, "--oneline"]),
  ]);
  return { repo, status, diffStat, log };
}

async function hasDotGit(dir) {
  try {
    const dotGit = path.join(dir, ".git");
    const s = await stat(dotGit);
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}

async function isGitRepo(dir) {
  if (await hasDotGit(dir)) return true;
  const result = await git(dir, ["rev-parse", "--show-toplevel"]);
  return path.resolve(result.trim()) === path.resolve(dir);
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
}
