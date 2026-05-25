import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("package exposes server plugin entrypoints for OpenCode npm loading", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));

  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "./src/plugin.js");
  assert.equal(pkg.exports["."], "./src/plugin.js");
  assert.equal(pkg.exports["./server"], "./src/plugin.js");
});
