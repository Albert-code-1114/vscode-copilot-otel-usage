"use strict";

const fs = require("fs");
const { normalize, emit } = require("../core/events");

/**
 * OTel JSONL data source — the public, licence-clean way to see token usage.
 *
 * Copilot Chat can export OpenTelemetry to a JSON-lines file:
 *
 *   "github.copilot.chat.otel.enabled": true,
 *   "github.copilot.chat.otel.exporterType": "file",
 *   "github.copilot.chat.otel.outfile": "C:\\Users\\me\\copilot-otel.jsonl"
 *
 * Expect THREE different kinds of record in that one file. `exporterType: "file"`
 * builds a span, a log and a metric exporter, and all three append to the same path:
 *
 *   {"resource":{...},"scopeMetrics":[...]}      metric envelopes (ignore)
 *   {}                                           empty lines from the span exporter
 *   {"hrTime":[..],"attributes":{...},...}       log records — the useful ones
 *
 * Token counts live on the LOG RECORDS, in a flat `attributes` OBJECT — not in the
 * OTLP `"attributes":[{"key":..,"value":{"intValue":..}}]` array form, which this
 * file does not actually use:
 *
 *   {"hrTime":[1750123000,123000000],
 *    "attributes":{"event.name":"gen_ai.client.inference.operation.details",
 *                  "gen_ai.request.model":"deepseek-chat",
 *                  "gen_ai.usage.input_tokens":1834,
 *                  "gen_ai.usage.output_tokens":412},
 *    "spanContext":{"traceId":"..","spanId":".."}}
 *
 * One model call is reported more than once: a `…inference.operation.details`
 * record and a `copilot_chat.agent.turn` twin carry identical counts inside the
 * SAME span, and several distinct calls can share one spanId. So ids are derived
 * from the span plus the counts, never from the span alone — see core/events.js.
 *
 * This provider tails that file: on start it replays it so a window reload does not
 * lose today's numbers, then polls for appended lines. De-duplication lives in
 * core/events.js, so replaying is safe.
 */

const OPERATION_KEYS = ["gen_ai.operation.name", "ai.operation.name"];
const CHAT_OPERATIONS = new Set([
  "chat",
  "text_completion",
  "embeddings",
  "invoke_agent",
  "execute_tool",
  "agent",
]);

const POLL_MS = 1000;

/** Decode one OTLP attribute value: {intValue|doubleValue|stringValue|boolValue|arrayValue|kvlistValue}. */
function decodeValue(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("boolValue" in v) return !!v.boolValue;
  if ("arrayValue" in v) {
    const vals = (v.arrayValue && v.arrayValue.values) || [];
    return vals.map(decodeValue);
  }
  if ("kvlistValue" in v) {
    const out = {};
    for (const kv of (v.kvlistValue && v.kvlistValue.values) || []) out[kv.key] = decodeValue(kv.value);
    return out;
  }
  if ("bytesValue" in v) return v.bytesValue;
  return undefined;
}

/** Attributes are a [{key,value}] array — but accept a plain object too. */
function decodeAttributes(attrs) {
  const out = {};
  if (!attrs) return out;
  if (Array.isArray(attrs)) {
    for (const kv of attrs) {
      if (!kv || typeof kv !== "object") continue;
      out[kv.key] = decodeValue(kv.value);
    }
    return out;
  }
  if (typeof attrs === "object") {
    for (const k of Object.keys(attrs)) out[k] = decodeValue(attrs[k]);
  }
  return out;
}

function toMs(v) {
  if (v === null || v === undefined || v === "") return 0;
  // The OTel SDK keeps HrTime as [seconds, nanoseconds]; the OTLP JSON form is a
  // single nanosecond count. Both shapes reach this parser.
  if (Array.isArray(v)) {
    const sec = Number(v[0]) || 0;
    const nano = Number(v[1]) || 0;
    if (!isFinite(sec) || sec <= 0) return 0;
    return Math.round(sec * 1000 + nano / 1e6);
  }
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  // nanoseconds since epoch -> ms (guard against anything already in ms/us)
  if (n > 1e17) return Math.round(n / 1e6);
  if (n > 1e14) return Math.round(n / 1e3);
  return Math.round(n);
}

/**
 * Ids live on `_spanContext` for raw SDK spans, and at the top level for the OTLP
 * JSON form. A stable id matters: without one, a file that is replayed on every
 * reload gets re-counted, because the fallback fingerprint includes the event
 * time (which falls back to `Date.now()`).
 */
function spanIds(span) {
  const ctx =
    span._spanContext ||
    (span.spanContext && typeof span.spanContext === "object" ? span.spanContext : null) ||
    {};
  return { traceId: span.traceId || ctx.traceId, spanId: span.spanId || ctx.spanId };
}

/**
 * Turn one decoded span into a UsageEvent, or null.
 * Works for the flat file-exporter shape AND for spans nested inside an OTLP
 * envelope (resourceSpans[].scopeSpans[].spans[]), so a future format change
 * degrades gracefully instead of silently counting nothing.
 */
function spanToEvent(span, source) {
  if (!span || typeof span !== "object") return null;
  const a = decodeAttributes(span.attributes);

  const operation = OPERATION_KEYS.map((k) => a[k]).find((v) => typeof v === "string") || "";
  if (operation && !CHAT_OPERATIONS.has(operation)) return null;

  const model =
    a["gen_ai.request.model"] ||
    a["gen_ai.response.model"] ||
    (typeof span.name === "string" ? span.name.replace(/^(chat|invoke_agent|execute_tool)\s+/, "") : "") ||
    "unknown";

  const ids = spanIds(span);
  const raw = {
    // The Copilot file exporter emits OTel *log records*, whose only time field is
    // `hrTime`/`hrTimeObserved` as [seconds, nanoseconds]. Spans use
    // startTime/endTime (HrTime) or *UnixNano; all four are accepted.
    t:
      toMs(span.endTimeUnixNano) ||
      toMs(span.hrTime) ||
      toMs(span.endTime) ||
      toMs(span.hrTimeObserved) ||
      toMs(span.startTimeUnixNano) ||
      toMs(span.startTime),
    input: a["gen_ai.usage.input_tokens"],
    output: a["gen_ai.usage.output_tokens"],
    cached: a["gen_ai.usage.cache_read.input_tokens"],
    reasoning: a["gen_ai.usage.reasoning.output_tokens"] || a["gen_ai.usage.reasoning_tokens"],
  };
  // A span with no token attributes at all is not a usage event.
  if (raw.input === undefined && raw.output === undefined) return null;

  // One model call is reported more than once inside the same span (a per-call
  // inference record plus an aggregate carrying identical counts), and several
  // distinct calls can share one span. Keying on the span alone would therefore
  // either double-count or collapse real calls, so the usage numbers are part of
  // the key: a twin pair merges, genuinely different calls stay separate. This id
  // is also what makes a replayed file idempotent across reloads, so it must not
  // depend on anything that changes between runs.
  const usageKey = `${raw.input || 0}:${raw.output || 0}`;
  const id = ids.spanId
    ? `${ids.traceId || ""}:${ids.spanId}:${usageKey}`
    : `${raw.t || 0}:${model}:${usageKey}`;

  const event = normalize(raw, String(model), source, {
    id,
    operation: operation || undefined,
  });
  if (!event) return null;
  // OTel reports input/output separately; make the total explicit.
  if (!event.total) event.total = event.input + event.output;
  return event;
}

function walkSpans(line, source, out) {
  const obj = JSON.parse(line);
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj.resourceSpans)) {
    for (const rs of obj.resourceSpans) {
      for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) {
        for (const sp of ss.spans || []) {
          const e = spanToEvent(sp, source);
          if (e) out.push(e);
        }
      }
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const sp of obj) {
      const e = spanToEvent(sp, source);
      if (e) out.push(e);
    }
    return;
  }
  const e = spanToEvent(obj, source);
  if (e) out.push(e);
}

class OtelFileProvider {
  constructor(opts) {
    const o = opts || {};
    this.id = "otel-file";
    this.label = "Copilot Chat OTel JSONL";
    this.filePath = o.filePath;
    this.source = o.source || "otel-file";
    this.log = o.log || (() => {});
    this.onStatus = o.onStatus || (() => {});
    this.timer = null;
    this.offset = 0;
    this.partial = "";
    this.lines = 0;
    this.spans = 0;
    this.usageSpans = 0;
    this.missingFileLogged = false;
  }

  start() {
    if (!this.filePath) {
      this.onStatus({ state: "unconfigured", detail: "未设置 OTel JSONL 路径" });
      this.log("otel-file: no outfile configured");
      return;
    }
    this.log(`otel-file: tailing ${this.filePath}`);
    this._drain();
    this.timer = setInterval(() => this._drain(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Pick up a changed `outfile` setting without a reload. */
  setFilePath(p) {
    if (p === this.filePath) return;
    this.filePath = p;
    this.offset = 0;
    this.partial = "";
    this.lines = 0;
    this.spans = 0;
    this.usageSpans = 0;
    this.missingFileLogged = false;
    this.log(`otel-file: path changed -> ${p}`);
    this._drain();
  }

  _drain() {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch (e) {
      this.onStatus({ state: "nofile", detail: "文件还不存在" });
      if (!this.missingFileLogged) {
        this.missingFileLogged = true;
        this.log(
          `otel-file: not found yet (${this.filePath}). 打开设置里的 "github.copilot.chat.otel.outfile" 后重载窗口。`
        );
      }
      return;
    }
    this.missingFileLogged = false;
    if (stat.size < this.offset) {
      // Truncated or rotated: restart from the top, dedupe handles repeats.
      this.log("otel-file: file shrank, restarting from byte 0");
      this.offset = 0;
      this.partial = "";
    }
    if (stat.size === this.offset) {
      this.onStatus({ state: "idle", detail: `${this.usageSpans} 个含用量的 span` });
      return;
    }

    let chunk = "";
    try {
      const fd = fs.openSync(this.filePath, "r");
      try {
        const len = stat.size - this.offset;
        const buf = Buffer.allocUnsafe(len);
        const read = fs.readSync(fd, buf, 0, len, this.offset);
        chunk = buf.slice(0, read).toString("utf8");
        this.offset += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      this.log(`otel-file: read failed: ${e && e.message}`);
      return;
    }

    const text = this.partial + chunk;
    const parts = text.split("\n");
    this.partial = parts.pop() || "";

    for (const raw of parts) {
      const line = raw.trim();
      if (!line || line[0] !== "{") continue;
      this.lines += 1;
      const events = [];
      try {
        walkSpans(line, this.source, events);
      } catch (e) {
        /* a partially flushed line: the next poll will not see it again, skip */
        continue;
      }
      for (const e of events) {
        this.spans += 1;
        if (emit(e)) this.usageSpans += 1;
      }
    }
    this.onStatus({ state: "ok", detail: `${this.usageSpans} 个含用量的 span / ${this.lines} 行` });
  }

  diagnose() {
    let exists = false;
    let size = 0;
    try {
      const s = fs.statSync(this.filePath);
      exists = true;
      size = s.size;
    } catch (e) {
      /* not there */
    }
    return {
      id: this.id,
      label: this.label,
      state: !this.filePath ? "未配置 outfile 路径" : !exists ? "文件不存在" : "已连接",
      lines: [
        `路径        : ${this.filePath || "(空)"}`,
        `文件存在    : ${exists ? `是 (${size} 字节, 已读 ${this.offset})` : "否"}`,
        `已解析行数  : ${this.lines}`,
        `含用量 span : ${this.usageSpans}`,
      ],
    };
  }
}

module.exports = { OtelFileProvider, decodeAttributes, decodeValue, spanToEvent, toMs };
