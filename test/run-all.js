"use strict";

/**
 * Run every test suite and exit non-zero if any of them fails.
 *
 * `smoke.test.js` and `activate.test.js` write their report to a `.md` file as well as
 * stdout, so the file is checked for FAIL lines as a second signal.
 *
 * Usage: node test/run-all.js   (or: npm test)
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const suites = [
  { name: "parser", file: "parser.test.js", report: null },
  { name: "smoke", file: "smoke.test.js", report: "smoke-result.md" },
  { name: "activate", file: "activate.test.js", report: "activate-result.md" },
  { name: "otel", file: "otel.test.js", report: null },
];

let failed = 0;
for (const s of suites) {
  console.log(`\n${"=".repeat(60)}\n${s.name}  (test/${s.file})\n${"=".repeat(60)}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, s.file)], { stdio: "inherit" });
  let ok = r.status === 0;

  if (s.report) {
    const p = path.join(__dirname, s.report);
    if (!fs.existsSync(p)) {
      console.log(`  no report written: ${s.report}`);
      ok = false;
    } else {
      const text = fs.readFileSync(p, "utf8");
      const bad = text.split("\n").filter((l) => l.startsWith("FAIL"));
      console.log(bad.length ? `\n${bad.join("\n")}` : `\n${text.trim().split("\n").pop()}`);
      if (bad.length) ok = false;
    }
  }

  if (!ok) failed += 1;
}

console.log(`\n${"=".repeat(60)}`);
console.log(failed === 0 ? `ALL SUITES PASSED (${suites.length}/${suites.length})` : `FAILED: ${failed} of ${suites.length} suites`);
console.log("=".repeat(60));
process.exit(failed === 0 ? 0 : 1);
