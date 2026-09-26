"use strict";

/** Compact human form: 1536 -> "1.5K", 2400000 -> "2.40M". */
function fmt(v) {
  const n = Number(v) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

/** Exact form with thousands separators: 1536 -> "1,536". */
function fmtExact(v) {
  return (Number(v) || 0).toLocaleString("en-US");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Local calendar day key, e.g. "2026-02-14". */
function dayKey(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

function timeOf(t) {
  return new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * Estimated cost for one bucket. `pricing` maps a lowercase model-name
 * substring to { in, out } USD-per-1M-tokens. Returns null when no rule
 * matches, so the UI can say "unknown" instead of showing a fake $0.00.
 */
function estimateCost(bucket, pricing) {
  if (!bucket || !pricing) return null;
  const name = String(bucket.model || "").toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const key of Object.keys(pricing)) {
    const k = key.toLowerCase();
    if (k && name.includes(k) && k.length > bestLen) {
      best = pricing[key];
      bestLen = k.length;
    }
  }
  if (!best) return null;
  const inRate = Number(best.in) || 0;
  const outRate = Number(best.out) || 0;
  return (bucket.input / 1e6) * inRate + (bucket.output / 1e6) * outRate;
}

module.exports = { fmt, fmtExact, dayKey, timeOf, estimateCost };
