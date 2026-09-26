"use strict";

/**
 * The one contract every data source must satisfy.
 *
 * A provider's ONLY job is to turn whatever it can observe into calls to
 * `emit(event)`. It must not know about the status bar, storage, or formatting.
 *
 * @typedef {Object} UsageEvent
 * @property {number}  t          epoch ms when the request finished
 * @property {string}  model      model id as reported by the data source
 * @property {number}  input      prompt / input tokens
 * @property {number}  output     completion / output tokens
 * @property {number}  total      input + output unless the source says otherwise
 * @property {number} [cached]    cached / cache-read input tokens
 * @property {number} [reasoning] reasoning tokens (already counted inside output)
 * @property {string}  source     provider id that produced the event
 * @property {string} [id]        stable id used for de-duplication
 * @property {string} [operation] source-specific operation name (e.g. "chat")
 */

const providers = new Map();
const listeners = new Set();

/**
 * Dedupe window. A provider that re-reads a file from the start (or a provider
 * that both tails a file AND receives an in-process hook) can legitimately see
 * the same request twice; the store drops repeats by `id` or by a synthetic
 * fingerprint within this window.
 */
const DEDUPE_WINDOW_MS = 15 * 60 * 1000;

let recentIds = new Map(); // id -> t

function fingerprint(e) {
  return `${e.t}|${e.model}|${e.input}|${e.output}`;
}

function isDuplicate(e) {
  const key = e.id ? `id:${e.id}` : `fp:${fingerprint(e)}`;
  const now = Date.now();
  const seenAt = recentIds.get(key);
  if (seenAt !== undefined && (e.id || now - seenAt < DEDUPE_WINDOW_MS)) return true;
  recentIds.set(key, e.t || now);
  if (recentIds.size > 4000) {
    // Cheap eviction: drop the oldest half.
    const entries = [...recentIds.entries()].sort((a, b) => a[1] - b[1]);
    recentIds = new Map(entries.slice(Math.floor(entries.length / 2)));
  }
  return false;
}

function num(v) {
  return typeof v === "number" && isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/**
 * Normalise the many `usage` shapes seen in the wild (OpenAI chat-completions,
 * Anthropic-style, OTel attribute names, ...) into a UsageEvent.
 *
 * @returns {UsageEvent|null} null when there is nothing countable
 */
function normalize(raw, model, source, extra) {
  if (!raw || typeof raw !== "object") return null;

  const inDetails = raw.prompt_tokens_details || raw.input_tokens_details || {};
  const outDetails = raw.completion_tokens_details || raw.output_tokens_details || {};

  const input = num(raw.input) || num(raw.prompt_tokens) || num(raw.input_tokens);
  const output = num(raw.output) || num(raw.completion_tokens) || num(raw.output_tokens);
  let total = num(raw.total) || num(raw.total_tokens);
  if (!total) total = input + output;
  if (!total) return null;

  const cached =
    num(raw.cached) ||
    num(inDetails.cached_tokens) ||
    num(raw.cache_read_input_tokens) ||
    num(raw.prompt_cache_hit_tokens);

  const reasoning =
    num(raw.reasoning) || num(outDetails.reasoning_tokens) || num(raw.reasoning_tokens);

  const event = {
    t: num(raw.t) || Date.now(),
    model: typeof model === "string" && model ? model : "unknown",
    input,
    output,
    total,
    cached,
    reasoning,
    source: source || "unknown",
  };
  if (extra) Object.assign(event, extra);
  return event;
}

/**
 * Register a provider. Called by the composition root only.
 * @param {{id: string, label: string, start: Function, stop?: Function}} provider
 */
function registerProvider(provider) {
  providers.set(provider.id, provider);
  return provider;
}

function getProviders() {
  return [...providers.values()];
}

/** Subscribe to normalised usage events. Returns an unsubscribe function. */
function onUsage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Publish an event. Providers call this; never throws (a broken provider must
 * not take down chat, and must not take down the status bar either).
 */
function emit(event) {
  try {
    if (!event) return false;
    if (!event.total && !event.input && !event.output) return false;
    if (isDuplicate(event)) return false;
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (e) {
        /* one bad listener must not stop the others */
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

function resetDedupe() {
  recentIds = new Map();
}

/**
 * Seed the de-duplication store from persisted state.
 *
 * `recentIds` lives in memory only. A provider that replays its source from the
 * beginning on every start (the OTel file tailer reads the file from byte 0 so a
 * reload does not lose the day's tail) would otherwise re-count everything the
 * previous session already counted. Restoring the ids makes a reload idempotent.
 *
 * @param {Array<{id: string, t?: number}>} entries
 */
function seedDedupe(entries) {
  if (!Array.isArray(entries)) return 0;
  let n = 0;
  for (const e of entries) {
    if (!e || typeof e.id !== "string" || !e.id) continue;
    recentIds.set(`id:${e.id}`, num(e.t) || Date.now());
    n += 1;
  }
  return n;
}

module.exports = { normalize, registerProvider, getProviders, onUsage, emit, resetDedupe, seedDedupe };
