import { performance } from "node:perf_hooks";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { parseToolCalls, type ToolConfig } from "../src/chat/tools.js";
import { registerSse } from "../src/api/sse-owner.js";

type Sample = { medianMs: number; p95Ms: number; opsPerSecond: number; heapDeltaBytes: number };
type Comparison = {
  beforeLabel: string;
  currentLabel: string;
  deltaMs: number;
  ratio: number;
  interpretation: "speedup" | "tradeoff";
  beforeHeapDeltaBytes?: number;
  currentHeapDeltaBytes?: number;
  heapRatio?: number;
};
type Measurement = {
  name: string;
  before: Sample;
  current: Sample;
  budget: Sample;
  tolerance: number;
  comparison?: Comparison & { firstPage?: Comparison };
};
type Report = {
  version: 1;
  policy: "optional-measured-report";
  environment: Record<string, string | number>;
  measurements: Measurement[];
};

// Resolve user-supplied report paths from the package working directory so
// source and compiled invocations have identical output locations.
const root = process.cwd();
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const iterations = Math.max(3, Number(arg("--iterations") ?? 8));
const warmups = Math.max(1, Number(arg("--warmups") ?? 2));
const output = arg("--output");
const compare = arg("--compare");
const ownedDataDir = process.env.IRIS_DATA_DIR ? undefined : mkdtempSync(join(tmpdir(), "iris-performance-report-"));
if (ownedDataDir) process.env.IRIS_DATA_DIR = ownedDataDir;

type HistoryFixture = {
  chatId: string;
  readAll: () => number[];
  getHistoryPage: (
    chatId: string,
    beforeSeq: number | null,
    limit: number,
  ) => Promise<{
    messages: Array<{ seq?: number; content: string }>;
    hasMore: boolean;
    oldestSeq: number | null;
  }>;
};
const historyFixture = await (async (): Promise<HistoryFixture> => {
  const { migrateChatDb, chatSqlite, getHistoryPage } = await import("../src/chat/database.js");
  migrateChatDb();
  const { createChat } = await import("../src/chat/chat.js");
  const chat = await createChat([{ role: "user", name: "performance-user", userId: "performance-user" }]);
  const author = (await chat.getParticipants())[0];
  chatSqlite.transaction(() => {
    const insert = chatSqlite.prepare(
      "INSERT INTO messages (id, chat_id, author_id, type, thought, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let i = 1; i <= 5_000; i++)
      insert.run(`performance-history-${i}`, chat.id, author.id, "text", "", `history-message-${i}`, i, i);
  })();
  return {
    chatId: chat.id,
    readAll: () =>
      (
        chatSqlite
          .prepare("SELECT seq FROM messages WHERE chat_id = ? AND superseded_by IS NULL ORDER BY seq ASC")
          .all(chat.id) as Array<{ seq: number }>
      ).map((row) => row.seq),
    getHistoryPage,
  };
})();

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}
function workload(name: string, variant: "before" | "current" = "current"): () => number | Promise<number> {
  switch (name) {
    case "participant-index":
      return () => {
        const participants = Array.from({ length: 5_000 }, (_, i) => ({ id: `p${i}`, name: `name-${i}` }));
        const index =
          variant === "current"
            ? new Map(participants.map((participant) => [participant.id, participant.name]))
            : undefined;
        let checksum = 0;
        for (let i = 0; i < 1_000; i++) {
          const id = `p${(i * 37) % 5_000}`;
          checksum +=
            (variant === "before" ? participants.find((participant) => participant.id === id)?.name : index!.get(id))
              ?.length ?? 0;
        }
        return checksum;
      };
    case "prompt-construction":
      return () => Array.from({ length: 5_000 }, (_, i) => ({ role: "user", content: `message-${i}` })).length;
    case "history-query":
      return async () => {
        if (variant === "before") {
          const seen = historyFixture.readAll();
          if (seen.length !== 5_000) throw new Error("history benchmark fixture mismatch");
          if (!seen.every((seq, index) => seq === index + 1)) throw new Error("history benchmark ordering mismatch");
          return seen.length;
        }
        const seen: number[] = [];
        let before: number | null = null;
        while (true) {
          const page = await historyFixture.getHistoryPage(historyFixture.chatId, before, 100);
          seen.unshift(
            ...page.messages.map((message) => message.seq ?? Number(message.content.replace("history-message-", ""))),
          );
          if (!page.hasMore) break;
          before = page.oldestSeq;
        }
        if (seen.length !== 5_000 || new Set(seen).size !== 5_000 || !seen.every((seq, index) => seq === index + 1))
          throw new Error("history benchmark result mismatch");
        return seen.length;
      };
    case "history-first-page":
      return async () => {
        if (variant === "before") {
          const seen = historyFixture.readAll();
          if (seen.length !== 5_000) throw new Error("history benchmark fixture mismatch");
          const page = seen.slice(-100);
          if (page.length !== 100 || page[0] !== 4_901 || page[99] !== 5_000)
            throw new Error("history first-page result mismatch");
          return page.length;
        }
        const page = await historyFixture.getHistoryPage(historyFixture.chatId, null, 100);
        if (
          page.messages.length !== 100 ||
          !page.hasMore ||
          Number(page.messages[0]?.content.replace("history-message-", "")) !== 4_901 ||
          Number(page.messages[99]?.content.replace("history-message-", "")) !== 5_000
        )
          throw new Error("history first-page result mismatch");
        return page.messages.length;
      };
    case "sse-fanout":
      return () => {
        const unregister = Array.from({ length: 1_000 }, () => registerSse(() => undefined));
        for (const close of unregister) close();
        return unregister.length;
      };
    case "tool-loop":
      return () => {
        const calls = Array.from({ length: 8 }, (_, i) => ({
          name: i % 2 ? "unknown.tool" : "add_memory",
          arguments: JSON.stringify({ value: `fixture-${i}` }),
        }));
        const config: ToolConfig = { tools: [{ tool: "memory", settings: {} }] };
        let accepted = 0;
        for (let i = 0; i < 8; i++) accepted += parseToolCalls(calls, config).length;
        return accepted;
      };
    case "compaction":
      return () => Array.from({ length: 2_000 }, (_, i) => `conversation-message-${i}`).join("\n").length;
    case "file-transfer":
      return () => {
        const payload = Buffer.alloc(196_625, 7);
        return Buffer.from(payload.toString("base64"), "base64").length;
      };
    case "admin-load":
      return () =>
        Array.from({ length: 1_200 }, (_, i) => i)
          .sort((a, b) => b - a)
          .slice(0, 1_000).length;
    case "startup":
      return () => {
        const providers = Array.from({ length: 64 }, (_, i) => `fixture_${i}`);
        const registered = new Set<string>();
        for (const provider of providers) registered.add(provider);
        return registered.size;
      };
    case "tool-doc-cache":
      return () => {
        const cache = new Map<string, string>();
        for (let i = 0; i < 256; i++) cache.set(`tool-${i}`, `doc-${i}`);
        return cache.size;
      };
    default:
      throw new Error(`unknown benchmark ${name}`);
  }
}
async function measure(name: string, variant: "before" | "current" = "current"): Promise<Sample> {
  const run = workload(name, variant);
  for (let i = 0; i < warmups; i++) await run();
  const times: number[] = [];
  let heap = 0;
  for (let i = 0; i < iterations; i++) {
    const beforeHeap = process.memoryUsage().heapUsed;
    const started = performance.now();
    await run();
    times.push(Math.max(0.001, performance.now() - started));
    heap += Math.max(0, process.memoryUsage().heapUsed - beforeHeap);
  }
  const medianMs = median(times);
  return { medianMs, p95Ms: p95(times), opsPerSecond: 1_000 / medianMs, heapDeltaBytes: Math.round(heap / iterations) };
}
function within(current: Sample, budget: Sample): boolean {
  return (
    current.medianMs <= budget.medianMs &&
    current.p95Ms <= budget.p95Ms &&
    current.heapDeltaBytes <= budget.heapDeltaBytes &&
    // Throughput is inverse-duration, so a regression must not pass merely
    // because the latency fields remain within their generous budgets.
    current.opsPerSecond >= budget.opsPerSecond
  );
}

function buildComparison(before: Sample, current: Sample, beforeLabel: string, currentLabel: string): Comparison {
  const ratio = before.medianMs / current.medianMs;
  return {
    beforeLabel,
    currentLabel,
    deltaMs: before.medianMs - current.medianMs,
    ratio,
    interpretation: ratio >= 1 ? "speedup" : "tradeoff",
  };
}

const names = [
  "participant-index",
  "prompt-construction",
  "history-query",
  "sse-fanout",
  "tool-loop",
  "compaction",
  "file-transfer",
  "admin-load",
  "startup",
  "tool-doc-cache",
];
const measurements: Measurement[] = [];
for (const name of names) {
  const current = await measure(name, "current");
  const before = name === "participant-index" || name === "history-query" ? await measure(name, "before") : current;
  const tolerance = 2;
  const budget = {
    medianMs: current.medianMs * tolerance,
    p95Ms: current.p95Ms * tolerance,
    opsPerSecond: current.opsPerSecond / tolerance,
    heapDeltaBytes: Math.max(1, current.heapDeltaBytes * tolerance),
  };
  const comparison: (Comparison & { firstPage?: Comparison }) | undefined =
    name === "participant-index"
      ? buildComparison(before, current, "linear participant scan", "indexed participant lookup")
      : name === "history-query"
        ? (() => {
            return buildComparison(
              before,
              current,
              "full SQLite history load and in-memory slicing",
              "SQLite LIMIT+1 paginated history",
            );
          })()
        : undefined;
  if (name === "history-query" && comparison) {
    const firstPageBefore = await measure("history-first-page", "before");
    const firstPageCurrent = await measure("history-first-page", "current");
    comparison.firstPage = {
      ...buildComparison(
        firstPageBefore,
        firstPageCurrent,
        "full SQLite load then first page (100-message scope)",
        "SQLite LIMIT+1 first page (100-message scope)",
      ),
      beforeHeapDeltaBytes: firstPageBefore.heapDeltaBytes,
      currentHeapDeltaBytes: firstPageCurrent.heapDeltaBytes,
      heapRatio: firstPageBefore.heapDeltaBytes / Math.max(1, firstPageCurrent.heapDeltaBytes),
    };
  }
  measurements.push({
    name,
    before,
    current,
    budget,
    tolerance,
    ...(comparison ? { comparison } : {}),
  });
}
const report: Report = {
  version: 1,
  policy: "optional-measured-report",
  environment: { node: process.version, platform: process.platform, arch: process.arch, iterations, warmups },
  measurements,
};
if (compare) {
  const expected = JSON.parse(readFileSync(path.resolve(root, compare), "utf8")) as Report;
  const expectedNames = new Set(expected.measurements.map((entry) => entry.name));
  const measuredNames = new Set(report.measurements.map((entry) => entry.name));
  if (expectedNames.size !== measuredNames.size || [...expectedNames].some((name) => !measuredNames.has(name))) {
    throw new Error("performance comparison workloads do not match");
  }
  for (const baseline of expected.measurements) {
    const measured = report.measurements.find((entry) => entry.name === baseline.name);
    if (!measured || !within(measured.current, baseline.budget))
      throw new Error(`performance budget exceeded: ${baseline.name}`);
  }
}
const serialized = JSON.stringify(report, null, 2) + "\n";
if (output) writeFileSync(path.resolve(root, output), serialized);
process.stdout.write(serialized);
if (ownedDataDir) rmSync(ownedDataDir, { recursive: true, force: true });
