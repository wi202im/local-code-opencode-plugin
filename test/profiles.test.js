import test from "node:test";
import assert from "node:assert/strict";
import { splitModelID } from "../src/profiles.js";

test("splitModelID splits provider/model", () => {
  assert.deepEqual(splitModelID("openai/gpt-5.3-codex"), { providerID: "openai", modelID: "gpt-5.3-codex" });
  assert.deepEqual(splitModelID("opencode-go/deepseek-v4-pro"), { providerID: "opencode-go", modelID: "deepseek-v4-pro" });
});

test("splitModelID handles no slash", () => {
  assert.deepEqual(splitModelID("gpt-5"), { providerID: "", modelID: "gpt-5" });
});
