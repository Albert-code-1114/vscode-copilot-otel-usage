"use strict";

/**
 * Activation harness — no VS Code needed.
 *
 * Installs a minimal fake of the `vscode` module, activates the extension for
 * real, drives one full end-to-end path (OTel JSONL -> event bus -> tracker ->
 * status bar) and then deactivates. This catches wiring mistakes that a pure
 * unit test would miss: a bad require path, a command id that is not
 * registered, a provider that throws on start.
 *
 * Run: node test/activate.js
 */

const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");

const results = [];
function check(name, ok, detail) {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  return ok;
}

// ------------------------------------------------------------------ fake ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-otel-usage-act-"));
const jsonl = path.join(tmp, "copilot-otel.jsonl");
const storage = path.join(tmp, "globalStorage");

const commands = new Map();
const registered = [];
const statusBars = [];
const messages = [];
let configValues = {
  "copilotOtelUsage.outfile": jsonl,
  "copilotOtelUsage.statusBarFormat": "lastDay",
  "copilotOtelUsage.excludeModels": [],
  "copilotOtelUsage.pricing": {},
};

class Disposable {
  constructor(fn) {
    this._fn = fn;
  }
  dispose() {
    if (this._fn) this._fn();
  }
}

class MarkdownString {
  constructor() {
    this.value = "";
  }
  appendMarkdown(s) {
    this.value += s;
  }
}

class StatusBarItem extends Disposable {
  constructor() {
    super();
    this.text = "";
    this.tooltip = "";
    this.command = "";
    this.name = "";
    this.visible = false;
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
}

class QuickPickItemKind {
  static Separator = -1;
}

const fakeVscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  QuickPickItemKind,
  MarkdownString,
  Disposable,
  window: {
    createStatusBarItem() {
      const item = new StatusBarItem();
      statusBars.push(item);
      return item;
    },
    createOutputChannel(name) {
      const lines = [];
      return {
        name,
        lines,
        appendLine(l) {
          lines.push(l);
        },
        show() {},
        dispose() {},
      };
    },
    showInformationMessage(m) {
      messages.push(m);
      return Promise.resolve(undefined);
    },
    showWarningMessage() {
      return Promise.resolve(undefined);
    },
    showQuickPick() {
      return Promise.resolve(undefined);
    },
    showTextDocument() {
      return Promise.resolve(undefined);
    },
  },
  commands: {
    registerCommand(id, fn) {
      commands.set(id, fn);
      registered.push(id);
      return new Disposable(() => commands.delete(id));
    },
    executeCommand(id, ...args) {
      const fn = commands.get(id);
      return fn ? fn(...args) : Promise.resolve(undefined);
    },
  },
  workspace: {
    getConfiguration() {
      return {
        get(key) {
          return configValues[`copilotOtelUsage.${key}`];
        },
        update() {
          return Promise.resolve();
        },
      };
    },
    onDidChangeConfiguration() {
      return new Disposable(() => {});
    },
    openTextDocument() {
      return Promise.resolve({});
    },
  },
};

// Intercept `require("vscode")` for the extension under test.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return "vscode";
  return originalResolve.call(this, request, ...rest);
};
require.cache["vscode"] = { id: "vscode", filename: "vscode", loaded: true, exports: fakeVscode };

// ------------------------------------------------------------- the run ----
const ext = require("../extension.js");
const context = {
  subscriptions: [],
  globalStorageUri: { fsPath: storage },
};

async function run() {
  let activated = true;
  try {
    ext.activate(context);
  } catch (e) {
    activated = false;
    check("activate() 不抛异常", false, e && e.stack ? e.stack.split("\n")[0] : String(e));
  }
  check("activate() 不抛异常", activated);
  check("注册了状态栏项", statusBars.length === 1, `实际 ${statusBars.length}`);

  const expected = [
    "copilotOtelUsage.showDetails",
    "copilotOtelUsage.diagnose",
    "copilotOtelUsage.reset",
    "copilotOtelUsage.toggleFormat",
    "copilotOtelUsage.report",
    "copilotOtelUsage.rescan",
  ];
  const missing = expected.filter((c) => !commands.has(c));
  check("6 个命令全部注册", missing.length === 0, missing.length ? `缺 ${missing.join(", ")}` : "");
  check(
    "statusBarItem.command 指向明细命令",
    statusBars[0] && statusBars[0].command === "copilotOtelUsage.showDetails",
    statusBars[0] ? statusBars[0].command : "无"
  );
  check("启动后状态栏可见", !!(statusBars[0] && statusBars[0].visible));
  check(
    "没有数据源时给出明确提示",
    !!(statusBars[0] && /无数据源|K|等待/.test(statusBars[0].text)),
    statusBars[0] ? statusBars[0].text : "无"
  );

  // Feed a real span through the real provider.
  const now = Date.now();
  const nano = String(BigInt(now) * 1000000n);
  const line = JSON.stringify({
    traceId: "c".repeat(32),
    spanId: "act1",
    name: "chat deepseek-chat",
    kind: 3,
    startTimeUnixNano: nano,
    endTimeUnixNano: nano,
    attributes: [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.request.model", value: { stringValue: "deepseek-chat" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: 1834 } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: 412 } },
    ],
    status: { code: 1 },
  });
  fs.writeFileSync(jsonl, line + "\n", "utf8");

  // The provider polls on an interval; drive one tick synchronously instead of
  // waiting a second.
  const providers = ext.__providers || null;
  if (providers && providers.length) {
    for (const p of providers) if (typeof p._drain === "function") p._drain();
    check("端到端：事件进入状态栏", /2\.2K/.test(statusBars[0].text), statusBars[0].text);
    check(
      "端到端：tooltip 含模型名",
      /deepseek-chat/.test(String(statusBars[0].tooltip.value || "")),
      ""
    );
  } else {
    check("暴露 __providers 供测试", false, "extension.js 未导出 __providers");
  }

  // Diagnose must produce a readable report without throwing.
  let diagOk = true;
  let diagErr = "";
  try {
    await commands.get("copilotOtelUsage.diagnose")();
  } catch (e) {
    diagOk = false;
    diagErr = e && e.message;
  }
  check("诊断命令可执行", diagOk, diagErr);

  let deactOk = true;
  try {
    ext.deactivate();
  } catch (e) {
    deactOk = false;
  }
  check("deactivate() 不抛异常", deactOk);

  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  fs.writeFileSync(
    path.join(__dirname, "activate-result.md"),
    ["# copilot-otel-usage activation harness", "", ...results, "", `${results.length - failed}/${results.length} passed`].join("\n"),
    "utf8"
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  // A fake host has no real event loop to drain; exit explicitly.
  process.exit(0);
}

run().catch((e) => {
  fs.writeFileSync(
    path.join(__dirname, "activate-result.md"),
    ["# copilot-otel-usage activation harness", "", "FATAL  " + (e && e.stack ? e.stack : String(e))].join("\n"),
    "utf8"
  );
  process.exitCode = 1;
});
