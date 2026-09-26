"use strict";

const fs = require("fs");
const path = require("path");
const { dayKey } = require("./format");

/**
 * Aggregates UsageEvents into "today" buckets and keeps a short rolling history.
 *
 * Persistence is best effort and debounced: the tracker is often fed from
 * inside a request pipeline, so nothing here may throw or block.
 */

const MAX_RECENT = 200;
const MAX_HISTORY_DAYS = 14;
/** Ids kept so a replayed source is not counted twice across reloads. */
const MAX_SEEN_IDS = 2000;
const SAVE_DEBOUNCE_MS = 800;

function emptyBucket() {
  return { calls: 0, input: 0, output: 0, cached: 0, reasoning: 0, total: 0 };
}

function addTo(bucket, e) {
  bucket.calls += 1;
  bucket.input += e.input || 0;
  bucket.output += e.output || 0;
  bucket.cached += e.cached || 0;
  bucket.reasoning += e.reasoning || 0;
  bucket.total += e.total || 0;
}

class UsageTracker {
  /**
   * @param {string} storageFile absolute path to the JSON state file
   * @param {{onChange?: Function}} [opts]
   */
  constructor(storageFile, opts) {
    this.storageFile = storageFile;
    this.onChange = (opts && opts.onChange) || (() => {});
    this.saveTimer = null;
    this.errors = 0;
    this.state = this._load();
    this._listeners = new Set();
  }

  _fresh() {
    return {
      date: dayKey(),
      day: emptyBucket(),
      byModel: {},
      bySource: {},
      recent: [],
      history: {},
      rejected: 0,
      seenIds: [],
    };
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storageFile, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.day) {
        const fresh = this._fresh();
        const merged = Object.assign(fresh, parsed);
        if (!merged.byModel || typeof merged.byModel !== "object") merged.byModel = {};
        if (!merged.bySource || typeof merged.bySource !== "object") merged.bySource = {};
        if (!merged.history || typeof merged.history !== "object") merged.history = {};
        if (!Array.isArray(merged.recent)) merged.recent = [];
        if (!Array.isArray(merged.seenIds)) merged.seenIds = [];
        if (typeof merged.rejected !== "number") merged.rejected = 0;
        // A state file written on a previous day: keep history, clear the day.
        if (merged.date !== dayKey()) {
          merged.history[merged.date] = merged.day;
          merged.date = dayKey();
          merged.day = emptyBucket();
          merged.byModel = {};
          merged.bySource = {};
          merged.recent = [];
          merged.rejected = 0;
        }
        this._trimHistory(merged);
        return merged;
      }
    } catch (e) {
      /* first run, or an unreadable/corrupt file */
    }
    return this._fresh();
  }

  _trimHistory(state) {
    const keys = Object.keys(state.history).sort();
    while (keys.length > MAX_HISTORY_DAYS) {
      delete state.history[keys.shift()];
    }
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of this._listeners) {
      try {
        fn(this.state);
      } catch (e) {
        /* ignore */
      }
    }
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  flush() {
    if (!this.storageFile || !this.state) return;
    try {
      fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
      fs.writeFileSync(this.storageFile, JSON.stringify(this.state), "utf8");
    } catch (e) {
      this.errors += 1;
    }
  }

  /** Midnight rollover: today's bucket moves into history. */
  rollDay() {
    const key = dayKey();
    if (this.state.date === key) return false;
    this.state.history[this.state.date] = this.state.day;
    this._trimHistory(this.state);
    this.state.date = key;
    this.state.day = emptyBucket();
    this.state.byModel = {};
    this.state.bySource = {};
    this.state.recent = [];
    this.state.rejected = 0;
    this.save();
    return true;
  }

  /**
   * Fold one event in. Returns the stored record, or null when it was rejected
   * (excluded model, or nothing countable).
   */
  record(e) {
    if (!e) return null;
    this.rollDay();
    const t = e.t || Date.now();
    // A provider that replays its source from the beginning hands back older
    // events too. They belong to their own day; counting them here would
    // silently inflate today's bucket every time the window reloads.
    if (dayKey(new Date(t)) !== dayKey()) return null;
    const rec = {
      t,
      model: e.model || "unknown",
      source: e.source || "unknown",
      input: e.input || 0,
      output: e.output || 0,
      cached: e.cached || 0,
      reasoning: e.reasoning || 0,
      total: e.total || 0,
      operation: e.operation,
    };
    if (!rec.total) return null;

    if (e.id) this._rememberId(e.id, t);
    addTo(this.state.day, rec);
    const modelBucket = this.state.byModel[rec.model] || (this.state.byModel[rec.model] = emptyBucket());
    addTo(modelBucket, rec);
    modelBucket.model = rec.model;
    const srcBucket = this.state.bySource[rec.source] || (this.state.bySource[rec.source] = emptyBucket());
    addTo(srcBucket, rec);
    srcBucket.model = rec.model;

    this.state.recent.unshift(rec);
    if (this.state.recent.length > MAX_RECENT) this.state.recent.length = MAX_RECENT;

    this.save();
    this._notify();
    return rec;
  }

  /** A provider saw something it could not turn into usage. */
  markRejected(n) {
    this.state.rejected += typeof n === "number" ? n : 1;
    this.save();
    this._notify();
  }

  /**
   * Remember an event id so the next session can skip it. Bounded: ids are only
   * useful while the source file still contains the events they refer to.
   */
  _rememberId(id, t) {
    const list = this.state.seenIds;
    list.push({ id, t });
    const over = list.length - MAX_SEEN_IDS;
    if (over > 0) list.splice(0, over);
  }

  reset() {
    this.state.day = emptyBucket();
    this.state.byModel = {};
    this.state.bySource = {};
    this.state.recent = [];
    this.state.rejected = 0;
    // Ids are cleared too: a reset means "count this day again from the source",
    // and a replayed source must not be suppressed by ids from before the reset.
    this.state.seenIds = [];
    this.state.date = dayKey();
    this.flush();
    this._notify();
  }

  get last() {
    return this.state.recent.length ? this.state.recent[0] : null;
  }

  modelsByTotal() {
    return Object.entries(this.state.byModel).sort((a, b) => b[1].total - a[1].total);
  }

  /** Yesterday's total, when a state file carried one over. */
  previousDay() {
    const keys = Object.keys(this.state.history).sort();
    if (!keys.length) return null;
    const key = keys[keys.length - 1];
    return { date: key, bucket: this.state.history[key] };
  }
}

module.exports = { UsageTracker, emptyBucket };
