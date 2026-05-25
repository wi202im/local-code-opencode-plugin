import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isInternalDiffPath } from "./internal-paths.js";

const execFileAsync = promisify(execFile);
const DEBUG = process.env.LOCAL_CODE_OPENCODE_DEBUG === "1";
const log = (...args) => DEBUG && console.error("[lc-context]", ...args);
const HASH_OBJECT_CHUNK_SIZE = 100;

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

export async function collectDiffSnapshot({ cwd = process.cwd() } = {}) {
  const workspaceRoot = path.resolve(cwd);
  const repos = await detectWorkspaceRepos(workspaceRoot);
  const repoSnapshots = await Promise.all(repos.map((repo) => collectRepoDiffSnapshot(repo)));
  return { workspaceRoot, repos: repoSnapshots };
}

export function diffStatsBetweenSnapshots(before, after) {
  const beforeRepos = new Map((before?.repos ?? []).map((repo) => [repo.repo.path, repo]));
  const afterRepos = new Map((after?.repos ?? []).map((repo) => [repo.repo.path, repo]));
  const multiRepo = new Set([...beforeRepos.keys(), ...afterRepos.keys()]).size > 1;
  const stats = [];

  for (const [repoPath, afterRepo] of afterRepos) {
    const beforeRepo = beforeRepos.get(repoPath);
    for (const [file, afterFile] of Object.entries(afterRepo.files ?? {})) {
      const beforeFile = beforeRepo?.files?.[file];
      if (beforeFile?.signature === afterFile.signature) continue;
      stats.push(formatSnapshotFile(afterRepo.repo, file, afterFile.diffStat, multiRepo));
    }
  }

  for (const [repoPath, beforeRepo] of beforeRepos) {
    const afterRepo = afterRepos.get(repoPath);
    for (const file of Object.keys(beforeRepo.files ?? {})) {
      if (afterRepo?.files?.[file]) continue;
      stats.push(formatSnapshotFile(beforeRepo.repo, file, "(reverted to clean during turn)", multiRepo));
    }
  }

  return stats;
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
  if (childRepos.length === 1) return childRepos;
  return [];
}

export async function collectRepoState(repo, { logLimit = 10 } = {}) {
  const [status, diffStat, log] = await Promise.all([
    git(repo.path, ["status", "--short", "--", ".", ":(exclude).opencode/local-code/**"]),
    git(repo.path, ["diff", "--stat", "--", ".", ":(exclude).opencode/local-code/**"]),
    git(repo.path, ["log", `-${logLimit}`, "--oneline"]),
  ]);
  return { repo, status, diffStat, log };
}

async function collectRepoDiffSnapshot(repo) {
  const [numstat, nameStatus, untracked] = await Promise.all([
    git(repo.path, ["diff", "HEAD", "--numstat"]),
    git(repo.path, ["diff", "HEAD", "--name-status"]),
    git(repo.path, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const signatures = new Map();
  const diffStats = new Map();

  for (const line of numstat.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const file = parts.at(-1);
    if (file && !isInternalDiffPath(file)) {
      signatures.set(file, line);
      diffStats.set(file, formatNumstatLine(file, parts));
    }
  }

  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const file = parts.at(-1);
    if (file && !isInternalDiffPath(file)) signatures.set(file, `${signatures.get(file) ?? ""}|${line}`);
  }

  const untrackedFiles = untracked.split("\n").filter((file) => file && !isInternalDiffPath(file));
  const untrackedHashes = await hashFiles(repo.path, untrackedFiles);
  for (const file of untrackedFiles) {
    if (isInternalDiffPath(file)) continue;
    const hash = untrackedHashes.get(file) ?? "";
    signatures.set(file, `untracked:${file}:${hash}`);
    diffStats.set(file, "(untracked file)");
  }

  const files = {};
  for (const [file, signature] of signatures) {
    files[file] = {
      signature,
      diffStat: diffStats.get(file) ?? "(changed)",
    };
  }
  return { repo, files };
}

function formatNumstatLine(file, parts) {
  const [added, deleted] = parts;
  if (!added || !deleted) return file;
  if (added === "-" || deleted === "-") return `${file} | binary changed`;
  const addedCount = Number(added);
  const deletedCount = Number(deleted);
  const total = addedCount + deletedCount;
  const markers = `${"+".repeat(Math.min(addedCount, 20))}${"-".repeat(Math.min(deletedCount, 20))}`;
  return `${file} | ${total} ${markers} (+${added} -${deleted})`;
}

async function hashFiles(cwd, files) {
  if (!files.length) return new Map();
  const entries = [];
  for (let index = 0; index < files.length; index += HASH_OBJECT_CHUNK_SIZE) {
    const chunk = files.slice(index, index + HASH_OBJECT_CHUNK_SIZE);
    const output = await git(cwd, ["hash-object", "--", ...chunk]);
    const hashes = output.split("\n").filter(Boolean);
    entries.push(...chunk.map((file, chunkIndex) => [file, hashes[chunkIndex] ?? ""]));
  }
  return new Map(entries);
}

function formatSnapshotFile(repo, file, diffStat, multiRepo) {
  const renderedPath = multiRepo ? `${repo.name}/${file}` : file;
  return {
    name: path.basename(file) || file,
    path: renderedPath,
    diffStat: diffStat || "(no changes)",
  };
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
  const result = await git(dir, ["rev-parse", "--show-toplevel"], { silent: true });
  return path.resolve(result.trim()) === path.resolve(dir);
}

async function git(cwd, args, { silent = false } = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    if (!silent) log("git failed:", args.join(" "), err?.message);
    return "";
  }
}
