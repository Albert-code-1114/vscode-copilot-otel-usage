"use strict";

/**
 * Offline smoke test — no VS Code needed.
 *
 * Feeds the OTel file provider a synthetic JSONL file shaped exactly like the
 * one Copilot Chat's `file` exporter writes, then checks what the tracker
 * ended up with. Run: node test/smoke.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const events = require("../src/core/events");
const { UsageTracker } = require("../src/core/tracker");
const { OtelFileProvider, spanToEvent, decodeAttributes, toMs } = require("../src/providers/otel-file");

const results = [];
function check(name, ok, detail) {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  return ok;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-otel-usage-"));
const jsonl = path.join(tmp, "copilot-otel.jsonl");

// --- synthetic records, in the shape the file exporter really writes -------
//
// The exporter writes OTel *log records*, not OTLP spans: `attributes` is a
// plain object, time is `hrTime` = [seconds, nanoseconds], and the ids live
// under `spanContext`. Emitting the OTLP shape here instead would test a record
// that never occurs in practice — which is exactly how a parser that reads none
// of these fields can still look green.
const now = Date.now();
const nano = String(BigInt(now) * 1000000n);
const hrNow = [Math.floor(now / 1000), (now - Math.floor(now / 1000) * 1000) * 1e6];

function span(name, attrs, spanId, op = "chat") {
  const attributes = { "event.name": name };
  if (op) attributes["gen_ai.operation.name"] = op;
  Object.assign(attributes, attrs);
  return JSON.stringify({
    hrTime: hrNow,
    hrTimeObserved: hrNow,
    spanContext: {
      traceId: "a".repeat(32),
      spanId: spanId || Math.random().toString(16).slice(2, 18),
      traceFlags: 1,
    },
    resource: { _rawAttributes: [["service.name", "copilot-chat"]] },
    instrumentationScope: { name: "copilot-chat", version: "0.0.0-test" },
    attributes,
    _body: name,
    totalAttributesCount: Object.keys(attributes).length,
    _isReadonly: true,
  });
}

const lines = [
  span("chat deepseek-chat", {
    "gen_ai.request.model": "deepseek-chat",
    "gen_ai.usage.input_tokens": 1834,
    "gen_ai.usage.output_tokens": 412,
    "gen_ai.usage.cache_read.input_tokens": 1024,
  }, "s1"),
  span("chat deepseek-chat", {
    "gen_ai.request.model": "deepseek-chat",
    "gen_ai.usage.input_tokens": 900,
    "gen_ai.usage.output_tokens": 100,
  }, "s2"),
  // a span with no usage: must be ignored, not counted as zero
  span("execute_tool read_file", { "gen_ai.tool.name": "read_file" }, "s3", "execute_tool"),
  // a non chat-ish operation: ignored
  span("core_event", { "copilot_chat.event_category": "x" }, "s4", "core_event"),
];
fs.writeFileSync(jsonl, lines.join("\n") + "\n", "utf8");

// --- provider -------------------------------------------------------------
const tracker = new UsageTracker(path.join(tmp, "usage.json"));
const seen = [];
events.onUsage((e) => {
  seen.push(e);
  tracker.record(e);
});

const provider = new OtelFileProvider({ filePath: jsonl, log: () => {} });
provider._drain();

check("解析出 2 条用量事件", seen.length === 2, `实际 ${seen.length}`);
check("首次事件 token 正确", seen[0] && seen[0].input === 1834 && seen[0].output === 412 && seen[0].total === 2246, seen[0] ? `in=${seen[0].input} out=${seen[0].output} total=${seen[0].total}` : "无");
check("缓存字段被识别", seen[0] && seen[0].cached === 1024, seen[0] ? String(seen[0].cached) : "无");
check("模型名正确", seen[0] && seen[0].model === "deepseek-chat", seen[0] ? seen[0].model : "无");
check("去重 id 每次调用唯一", seen[0] && seen[0].id === `${"a".repeat(32)}:s1:1834:412`, seen[0] ? String(seen[0].id) : "无");

// --- re-drain must not double count --------------------------------------
provider._drain();
check("重复 drain 不重复计数", seen.length === 2, `实际 ${seen.length}`);

// --- appended lines are picked up ----------------------------------------
fs.appendFileSync(jsonl, span("chat gpt-4o", {
  "gen_ai.request.model": "gpt-4o",
  "gen_ai.usage.input_tokens": 10,
  "gen_ai.usage.output_tokens": 20,
}, "s5") + "\n", "utf8");
provider._drain();
check("追加内容被拾取", seen.length === 3, `实际 ${seen.length}`);

// --- truncation restarts without double counting -------------------------
fs.writeFileSync(jsonl, span("chat deepseek-chat", {
  "gen_ai.request.model": "deepseek-chat",
  "gen_ai.usage.input_tokens": 1834,
  "gen_ai.usage.output_tokens": 412,
}, "s1") + "\n", "utf8");
provider._drain();
check("文件被截断后重放不重复计数", seen.length === 3, `实际 ${seen.length}`);

// --- aggregation ---------------------------------------------------------
const st = tracker.state;
check("今日合计 = 2246 + 1000 + 30", st.day.total === 3276, `实际 ${st.day.total}`);
check("请求数 = 3", st.day.calls === 3, `实际 ${st.day.calls}`);
check("按模型拆分正确", tracker.modelsByTotal().length === 2, `实际 ${tracker.modelsByTotal().length}`);

// --- OTLP envelope fallback ---------------------------------------------
const enveloped = JSON.stringify({
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "copilot-chat" } }] },
      scopeSpans: [
        {
          scope: { name: "github.copilot.chat" },
          spans: [
            {
              traceId: "b".repeat(32),
              spanId: "env1",
              name: "chat x",
              startTimeUnixNano: nano,
              endTimeUnixNano: nano,
              attributes: [
                { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                { key: "gen_ai.request.model", value: { stringValue: "enveloped-model" } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: 5 } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: 7 } },
              ],
            },
          ],
        },
      ],
    },
  ],
});
const envEvents = [];
function walkCheck() {
  const obj = JSON.parse(enveloped);
  for (const rs of obj.resourceSpans)
    for (const ss of rs.scopeSpans)
      for (const sp of ss.spans) {
        const e = spanToEvent(sp, "otel-file");
        if (e) envEvents.push(e);
      }
}
walkCheck();
check("OTLP envelope 形式也能解析", envEvents.length === 1 && envEvents[0].total === 12, `实际 ${envEvents.length}`);

// --- dedupe: same request from two sources -------------------------------
events.resetDedupe();
const before = seen.length;
events.emit({ t: Date.now(), model: "m", input: 1, output: 2, total: 3, source: "otel-file", id: "dup:1" });
events.emit({ t: Date.now(), model: "m", input: 1, output: 2, total: 3, source: "other", id: "dup:1" });
check("同一 id 跨数据源只计一次", seen.length === before + 1, `实际新增 ${seen.length - before}`);

// --- fingerprint dedupe --------------------------------------------------
events.resetDedupe();
const t0 = Date.now();
const b2 = seen.length;
events.emit({ t: t0, model: "m2", input: 10, output: 20, total: 30, source: "other" });
events.emit({ t: t0, model: "m2", input: 10, output: 20, total: 30, source: "other" });
check("无 id 时按指纹去重", seen.length === b2 + 1, `实际新增 ${seen.length - b2}`);

// --- toMs ----------------------------------------------------------------
check("纳秒转毫秒", Math.abs(toMs(nano) - now) < 5, `${toMs(nano)} vs ${now}`);
check("hrTime 数组转毫秒", toMs(hrNow) === now, `${toMs(hrNow)} vs ${now}`);
check("毫秒输入不被再次缩放", toMs(now) === now, String(toMs(now)));

// --- decode attributes ---------------------------------------------------
const decoded = decodeAttributes([
  { key: "a", value: { intValue: 5 } },
  { key: "b", value: { doubleValue: 1.5 } },
  { key: "c", value: { stringValue: "x" } },
  { key: "d", value: { boolValue: true } },
  { key: "e", value: { arrayValue: { values: [{ intValue: 1 }, { intValue: 2 }] } } },
]);
check("属性解码", decoded.a === 5 && decoded.b === 1.5 && decoded.c === "x" && decoded.d === true && JSON.stringify(decoded.e) === "[1,2]", JSON.stringify(decoded));

// --- write out -----------------------------------------------------------
const failed = results.filter((r) => r.startsWith("FAIL")).length;
const report = ["# copilot-otel-usage smoke test", "", ...results, "", `${results.length - failed}/${results.length} passed`].join("\n");
fs.writeFileSync(path.join(__dirname, "smoke-result.md"), report, "utf8");
fs.rmSync(tmp, { recursive: true, force: true });
