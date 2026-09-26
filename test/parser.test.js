"use strict";

/**
 * Offline unit test for the OTel JSONL parser.
 *
 * Three record shapes can reach the parser:
 *
 *   1. raw OTel SDK shape - `attributes` is an OBJECT, times are HrTime arrays
 *      [seconds, nanoseconds], and the ids live on `_spanContext`
 *   2. OTLP JSON shape    - `attributes` is a [{key,value}] ARRAY, times are
 *      `startTimeUnixNano`/`endTimeUnixNano`, ids are top level
 *   3. what Copilot Chat's `file` exporter ACTUALLY writes: an OTel *log
 *      record* - flat, `attributes` as an object, time in `hrTime`, ids on
 *      `spanContext`, and no top-level `name`. This is the real-world case and
 *      the reason the first two shapes alone are not enough to trust.
 *
 * Usage: node test/parser.test.js [path-to-otel-file.js]
 */

const path = require("path");

const target =
  process.argv[2] ||
  path.join(__dirname, "..", "src", "providers", "otel-file.js");

const { spanToEvent, toMs } = require(path.resolve(target));
const events = require(path.join(path.dirname(path.resolve(target)), "..", "core", "events"));

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  [PASS] ${label}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${label}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);
  }
}

console.log(`parser under test: ${path.resolve(target)}\n`);

// --- shape 1: raw OTel SDK span -------------------------------------------------
const sdkSpan = {
  _spanContext: { traceId: "aaaabbbbccccdddd", spanId: "1111222233334444", traceFlags: 1 },
  parentSpanId: "",
  startTime: [1758897000, 123000000],
  endTime: [1758897005, 456000000],
  attributes: {
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "deepseek-flash",
    "gen_ai.usage.input_tokens": 30622,
    "gen_ai.usage.output_tokens": 435,
  },
  status: { code: 1 },
  name: "chat deepseek-flash",
  kind: 2,
};

console.log("shape 1: raw OTel SDK span (object attributes + HrTime arrays)");
const e1 = spanToEvent(sdkSpan, "otel-file");
check("produces an event", !!e1, true);
check("input", e1 && e1.input, 30622);
check("output", e1 && e1.output, 435);
check("total", e1 && e1.total, 31057);
check("model", e1 && e1.model, "deepseek-flash");
check("timestamp (from endTime HrTime)", e1 && e1.t, 1758897005456);
check("stable id (from _spanContext, per call)", e1 && e1.id, "aaaabbbbccccdddd:1111222233334444:30622:435");
check("operation", e1 && e1.operation, "chat");

// --- shape 2: OTLP JSON span ----------------------------------------------------
const otlpSpan = {
  traceId: "eeeeffff00001111",
  spanId: "5555666677778888",
  startTimeUnixNano: "1758897000000000000",
  endTimeUnixNano: "1758897005000000000",
  attributes: [
    { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
    { key: "gen_ai.request.model", value: { stringValue: "deepseek-chat" } },
    { key: "gen_ai.usage.input_tokens", value: { intValue: 1000 } },
    { key: "gen_ai.usage.output_tokens", value: { intValue: 200 } },
  ],
  name: "chat deepseek-chat",
};

console.log("\nshape 2: OTLP JSON span (array attributes + *UnixNano)");
const e2 = spanToEvent(otlpSpan, "otel-file");
check("produces an event", !!e2, true);
check("input", e2 && e2.input, 1000);
check("output", e2 && e2.output, 200);
check("total", e2 && e2.total, 1200);
check("model", e2 && e2.model, "deepseek-chat");
check("timestamp", e2 && e2.t, 1758897005000);
check("stable id", e2 && e2.id, "eeeeffff00001111:5555666677778888:1000:200");

// --- shape 3: the shape Copilot actually writes ---------------------------------
// The file exporter emits OTel *log records*: time is hrTime, the ids sit on
// `spanContext`, and there is no top-level `name`. This is the real-world case.
const logRecord = {
  hrTime: [1790429734, 824000000],
  hrTimeObserved: [1790429734, 824000000],
  spanContext: { traceId: "dd786bfc280dbd184c0656b27ff51636", spanId: "47a206a26a42be62", traceFlags: 1 },
  resource: { _rawAttributes: [["service.name", "copilot-chat"]] },
  instrumentationScope: { name: "copilot-chat", version: "0.67.0" },
  attributes: {
    "event.name": "gen_ai.client.inference.operation.details",
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "deepseek-flash",
    "gen_ai.usage.input_tokens": 32678,
    "gen_ai.usage.output_tokens": 310,
  },
  _body: "gen_ai.client.inference.operation.details",
  totalAttributesCount: 5,
  _isReadonly: true,
};

console.log("\nshape 3: OTel LogRecord (hrTime + spanContext) - what Copilot really writes");
const e3 = spanToEvent(logRecord, "otel-file");
check("produces an event", !!e3, true);
check("input", e3 && e3.input, 32678);
check("output", e3 && e3.output, 310);
check("total", e3 && e3.total, 32988);
check("model", e3 && e3.model, "deepseek-flash");
check("timestamp (from hrTime)", e3 && e3.t, 1790429734824);
check("id (spanContext + usage)", e3 && e3.id, "dd786bfc280dbd184c0656b27ff51636:47a206a26a42be62:32678:310");

console.log("\nsame span, two DIFFERENT calls (must both count)");
const callA = { ...logRecord, attributes: { ...logRecord.attributes, "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 10 } };
const callB = { ...logRecord, attributes: { ...logRecord.attributes, "gen_ai.usage.input_tokens": 2000, "gen_ai.usage.output_tokens": 20 } };
const ea = spanToEvent(callA, "s");
const eb = spanToEvent(callB, "s");
check("ids differ per call", ea.id !== eb.id, true);
events.resetDedupe();
let nBoth = 0;
const offBoth = events.onUsage(() => {
  nBoth += 1;
});
events.emit(ea);
events.emit(eb);
offBoth();
check("both delivered", nBoth, 2);

console.log("\nsame call reported twice in one span (must count once)");
const twin = {
  ...logRecord,
  attributes: { ...logRecord.attributes, "event.name": "copilot_chat.agent.turn" },
  _body: "copilot_chat.agent.turn",
};
events.resetDedupe();
let nTwin = 0;
const offTwin = events.onUsage(() => {
  nTwin += 1;
});
events.emit(spanToEvent(logRecord, "s"));
events.emit(spanToEvent(twin, "s"));
offTwin();
check("twin pair merged into one", nTwin, 1);

// --- negatives ------------------------------------------------------------------
console.log("\nnegative cases");
check("span with no usage attributes -> null", spanToEvent({ name: "chat x", attributes: { "gen_ai.operation.name": "chat" } }, "s"), null);
check("non-chat operation -> null", spanToEvent({ ...sdkSpan, attributes: { ...sdkSpan.attributes, "gen_ai.operation.name": "file_read" } }, "s"), null);
check("garbage -> null", spanToEvent(null, "s"), null);
check("toMs([sec,nano])", toMs([1758897000, 500000000]), 1758897000500);
check("toMs(ns string)", toMs("1758897005000000000"), 1758897005000);
check("toMs(undefined)", toMs(undefined), 0);

// --- replay de-duplication ------------------------------------------------------
// The tracker/provider replays the whole file on every start, so the same span is
// emitted twice across two runs. A stable id is what makes that safe.
console.log("\nreplay de-duplication (emit the same span twice)");
events.resetDedupe();
let delivered = 0;
const off = events.onUsage(() => {
  delivered += 1;
});
const a = spanToEvent(sdkSpan, "otel-file");
const b = spanToEvent(sdkSpan, "otel-file");
const first = events.emit(a);
const second = events.emit(b);
off();
check("first emit accepted", first, true);
check("replayed emit dropped", second, false);
check("listener called once", delivered, 1);

console.log(`\n${fail === 0 ? "RESULT: PASS" : "RESULT: FAIL"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
