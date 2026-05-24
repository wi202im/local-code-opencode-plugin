import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = ".opencode/local-code/spike-logs";
const MAX_ENTRIES = 300;

const SKIP_TYPES = new Set(["message.part.delta"]);

let entries = [];
let logSeq = 0;

function safeSerialize(obj) {
  try {
    return JSON.parse(JSON.stringify(obj, (_key, value) => {
      if (typeof value === "bigint") return Number(value);
      if (Buffer.isBuffer(value)) return "[Buffer]";
      return value;
    }));
  } catch {
    return "[unserializable]";
  }
}

function shape(obj, depth = 0) {
  if (obj == null || depth > 2) return depth > 2 ? "[truncated]" : String(obj);
  if (Array.isArray(obj)) {
    return obj.length <= 3
      ? obj.map((item) => shape(item, depth + 1))
      : `[${obj.length} items]`;
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj);
    const out = {};
    for (const k of keys.slice(0, 12)) {
      const v = obj[k];
      if (typeof v === "object" && v !== null) {
        out[k] = shape(v, depth + 1);
      } else if (typeof v === "string" && v.length > 120) {
        out[k] = v.slice(0, 120) + "...";
      } else {
        out[k] = v;
      }
    }
    if (keys.length > 12) out["..."] = `+${keys.length - 12} more`;
    return out;
  }
  return obj;
}

async function flush() {
  if (!entries.length) return;
  const file = path.join(OUT_DIR, `spike-${Date.now()}-${++logSeq}.json`);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(entries, null, 2));
  entries = [];
}

export const EventSpikePlugin = async ({ directory }) => {
  const root = directory ?? process.cwd();

  console.error("[event-spike] logging to", path.join(root, OUT_DIR));

  let flushTimer;

  async function record(raw) {
    const eventType = raw?.type ?? "unknown";

    if (SKIP_TYPES.has(eventType)) return;

    const entry = {
      seq: entries.length + 1,
      eventType,
      timestamp: new Date().toISOString(),
      shaped: shape(raw),
      raw: safeSerialize(raw),
    };

    entries.push(entry);

    if (entries.length >= MAX_ENTRIES) await flush();

    clearTimeout(flushTimer);
    flushTimer = setTimeout(async () => { await flush(); }, 3000);
  }

  return {
    event: async ({ event }) => {
      await record(event);
    },
  };
};

export default EventSpikePlugin;
