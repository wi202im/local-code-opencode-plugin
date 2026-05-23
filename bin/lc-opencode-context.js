#!/usr/bin/env node
import { buildContextPayload } from "../src/context.js";
import { renderModelHandoffPrompt } from "../src/handoff.js";

const args = parseArgs(process.argv.slice(2));

try {
  const payload = await buildContextPayload({
    cwd: args.cwd ?? process.cwd(),
    previousModel: args["previous-model"] ?? args.previousModel ?? "unknown",
    nextModel: args["next-model"] ?? args.nextModel ?? "unknown",
    logLimit: Number(args["log-limit"] ?? 10),
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderModelHandoffPrompt(payload)}\n`);
  }
} catch (error) {
  process.stderr.write(`lc-opencode-context failed: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}
