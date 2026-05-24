import { execFileSync } from "node:child_process";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function makeTempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function initRepo(dir, files = { "README.md": "hello\n" }) {
  git(dir, ["init"]);
  for (const [file, content] of Object.entries(files)) {
    await writeFile(path.join(dir, file), content);
    git(dir, ["add", file]);
  }
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
}

export async function initWorkspace(root, names) {
  for (const name of names) {
    const dir = path.join(root, name);
    await mkdir(dir);
    await initRepo(dir, { "README.md": `${name}\n` });
  }
}

export function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
