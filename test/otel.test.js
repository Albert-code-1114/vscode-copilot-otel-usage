"use strict";

/**
 * Integration test for the OTel JSONL route, with no VS Code and no real data.
 *
 * A synthetic export file is built in the shape Copilot Chat's `file` exporter
 * actually writes (OTel log records: `hrTime` + `spanContext` + `attributes`
 * object), then the provider/tracker pair is driven exactly the way
 * `extension.js` drives it across simulated window reloads.
 *
 * It asserts the four things that are easy to get wrong and impossible to notice
 * in the status bar:
 *
 *   1. one model call reported twice in the SAME span must count once
 *      (Copilot writes both a per-call record and an `agent.turn` aggregate)
 *   2. two DIFFERENT calls sharing one span must count twice
 *      (a whole turn reuses one span, so span-level de-duplication loses calls)
 *   3. a reload replays the file from byte 0 and must add nothing
 *   4. a record from a previous day must not land in today's bucket
 *
 * Usage: node test/otel.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const core = path.join(REPO, "src", "core");
const provPath = path.join(REPO, "src", "providers", "otel-file.js");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  [PASS] ${label}`);
  } else {
    fail += 1;
    console.log(
      `  [FAIL] ${label}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`
    );
  }
}

// --------------------------------------------------------------- fixture ---

const DAY = 24 * 3600 * 1000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-otel-usage-"));
const jsonl = path.join(tmp, "copilot-otel.jsonl");

/** Today at a fixed local wall-clock time, so "today" never depends on when this runs. */
function todayAt(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

const T = {
  d1: todayAt(9, 15),
  d2: todayAt(9, 16),
  d3: todayAt(9, 17),
  d4: todayAt(9, 18),
  g1: todayAt(9, 19),
  old: todayAt(9, 20) - 3 * DAY,
};

/** One line of the export, in the real log-record shape. */
function record({ traceId, spanId, event, model, input, output, at }) {
  const attributes = { "event.name": event };
  if (model) {
    attributes["gen_ai.request.model"] = model;
    attributes["gen_ai.operation.name"] = "chat";
  }
  if (input != null) {
    attributes["gen_ai.usage.input_tokens"] = input;
    attributes["gen_ai.usage.output_tokens"] = output;
  }
  const sec = Math.floor(at / 1000);
  const nano = (at - sec * 1000) * 1e6;
  return JSON.stringify({
    hrTime: [sec, nano],
    hrTimeObserved: [sec, nano],
    spanContext: { traceId, spanId, traceFlags: 1 },
    resource: { _rawAttributes: [["service.name", "copilot-chat"]] },
    instrumentationScope: { name: "copilot-chat", version: "0.0.0-test" },
    attributes,
    _body: event,
    totalAttributesCount: Object.keys(attributes).length,
    _isReadonly: true,
  });
}

const trace = (c) => c.repeat(32);
const span = (c) => c.repeat(16);
const INFER = "gen_ai.client.inference.operation.details";
const TURN = "copilot_chat.agent.turn";

const lines = [
  // (1) one call, written twice in the same span -> must count ONCE
  record({ traceId: trace("a"), spanId: span("1"), event: INFER, model: "deepseek-chat", input: 1000, output: 100, at: T.d1 }),
  record({ traceId: trace("a"), spanId: span("1"), event: TURN, input: 1000, output: 100, at: T.d1 }),
  // (2) two DIFFERENT calls sharing one span -> must count TWICE
  record({ traceId: trace("a"), spanId: span("2"), event: INFER, model: "deepseek-chat", input: 2000, output: 200, at: T.d2 }),
  record({ traceId: trace("a"), spanId: span("2"), event: INFER, model: "deepseek-chat", input: 2500, output: 250, at: T.d3 }),
  // a third call, own span
  record({ traceId: trace("b"), spanId: span("3"), event: INFER, model: "deepseek-chat", input: 3000, output: 300, at: T.d4 }),
  // a different model, excluded by config
  record({ traceId: trace("b"), spanId: span("4"), event: INFER, model: "gpt-4o-mini", input: 50, output: 5, at: T.g1 }),
  // a previous day, must not enter today
  record({ traceId: trace("c"), spanId: span("5"), event: INFER, model: "deepseek-chat", input: 9999, output: 999, at: T.old }),
  // no usage at all -> ignored
  record({ traceId: trace("c"), spanId: span("6"), event: "copilot_chat.session.start", at: T.d1 }),
  record({ traceId: trace("c"), spanId: span("6"), event: "copilot_chat.tool.call", at: T.d1 }),
];

fs.writeFileSync(jsonl, lines.join("\n") + "\n", "utf8");

// expected numbers, derived by hand from the fixture above
const DEEPSEEK = { calls: 4, input: 8500, output: 850, total: 9350 };
const GPT = { calls: 1, input: 50, output: 5, total: 55 };
const ALL = { calls: 5, input: 8550, output: 855, total: 9405 };

// -------------------------------------------------------------- harness ---

/** Load a completely fresh module graph, the way a window reload would. */
function freshSession() {
  for (const p of [path.join(core, "events.js"), path.join(core, "tracker.js"), path.join(core, "format.js"), provPath]) {
    delete require.cache[require.resolve(p)];
  }
  return {
    events: require(path.join(core, "events.js")),
    UsageTracker: require(path.join(core, "tracker.js")).UsageTracker,
    OtelFileProvider: require(provPath).OtelFileProvider,
  };
}

/** Wire a session the way extension.js does, then drain the provider once. */
function runSession(storageFile, exclude) {
  const s = freshSession();
  const tracker = new s.UsageTracker(storageFile);
  const seen = [];

  // extension.js seeds the de-duplication store from persisted state on activate.
  const seeded = s.events.seedDedupe(tracker.state.seenIds);
  s.events.onUsage((e) => {
    seen.push(e);
    if (exclude && exclude.some((p) => String(e.model).toLowerCase().includes(p))) return;
    tracker.record(e);
  });

  const provider = new s.OtelFileProvider({ filePath: jsonl, log: () => {}, onStatus: () => {} });
  provider._drain();
  tracker.flush();

  return { tracker, seeded, seen, provider, events: s.events, OtelFileProvider: s.OtelFileProvider };
}

const storage = path.join(tmp, "usage.json");

console.log(`fixture : ${jsonl}`);
console.log(`records : ${lines.length}\n`);

console.log("session 1 - first ever start");
const s1 = runSession(storage, null);
const t1 = s1.tracker.state.day;
console.log(`  calls=${t1.calls} in=${t1.input} out=${t1.output} total=${t1.total}`);
console.log(`  by model: ${Object.entries(s1.tracker.state.byModel).map(([m, b]) => `${m}=${b.calls}/${b.total}`).join("  ")}`);
check("every distinct call counted", t1.calls, ALL.calls);
check("inputs summed", t1.input, ALL.input);
check("outputs summed", t1.output, ALL.output);
check("total = input + output", t1.total, ALL.total);
const ds = s1.tracker.state.byModel["deepseek-chat"];
check("deepseek-chat call count", ds && ds.calls, DEEPSEEK.calls);
check("deepseek-chat input", ds && ds.input, DEEPSEEK.input);
check("deepseek-chat output", ds && ds.output, DEEPSEEK.output);
check("deepseek-chat total", ds && ds.total, DEEPSEEK.total);
check("per-model split is present", !!s1.tracker.state.byModel["gpt-4o-mini"], true);
check("ids remembered per call", s1.tracker.state.seenIds.length, ALL.calls);

console.log("\ntimestamps come from hrTime, not from the moment of reading");
const first = s1.seen.find((e) => e.t === T.d1);
check("hrTime [sec,nano] decoded to the right millisecond", !!first, true);
check("millisecond precision preserved", s1.seen.some((e) => e.t === T.d2), true);
check("every event carries a fixture timestamp", s1.seen.filter((e) => e.t !== T.old).every((e) => Object.values(T).includes(e.t)), true);

console.log("\nprevious-day record is excluded from today");
check("today's total has no yesterday in it", t1.total, ALL.total);
check("yesterday's 10998 tokens are absent", t1.total < 10998, true);

console.log("\nsession 2 - simulated window reload (replays the same file)");
const s2 = runSession(storage, null);
const t2 = s2.tracker.state.day;
console.log(`  ids seeded=${s2.seeded}  calls=${t2.calls} total=${t2.total}`);
check("seeding restored the ids", s2.seeded, ALL.calls);
check("reload added no events", t2.calls, t1.calls);
check("reload did not inflate today's total", t2.total, t1.total);

console.log("\nsession 3 - same file with the utility model excluded");
const s3 = runSession(path.join(tmp, "usage-excluded.json"), ["gpt-4o-mini"]);
const t3 = s3.tracker.state.day;
console.log(`  calls=${t3.calls} in=${t3.input} out=${t3.output} total=${t3.total}`);
check("excluded model absent from the breakdown", !!s3.tracker.state.byModel["gpt-4o-mini"], false);
check("excluded model removed from the total", t3.total, ALL.total - GPT.total);
check("remaining calls unaffected", t3.calls, DEEPSEEK.calls);

console.log("\nreset + rescan - rebuild today from the source");
// Exactly what the `copilotOtelUsage.rescan` command does.
s1.tracker.reset();
s1.events.resetDedupe();
const replay = new s1.OtelFileProvider({ filePath: jsonl, log: () => {}, onStatus: () => {} });
replay._drain();
s1.tracker.flush();
check("rescan rebuilt the same total", s1.tracker.state.day.total, ALL.total);
check("rescan did not leave it empty", s1.tracker.state.day.calls > 0, true);

console.log("\nreset alone clears the remembered ids");
const s4 = freshSession();
const tr4 = new s4.UsageTracker(path.join(tmp, "usage-reset.json"));
s4.events.onUsage((e) => tr4.record(e));
new s4.OtelFileProvider({ filePath: jsonl, log: () => {}, onStatus: () => {} })._drain();
tr4.reset();
check("bucket zeroed", tr4.state.day.total, 0);
check("ids zeroed too, so a replay can re-count", tr4.state.seenIds.length, 0);

console.log(`\n${fail === 0 ? "RESULT: PASS" : "RESULT: FAIL"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
