"use strict";

/**
 * Copilot Token Usage — see how many tokens Copilot Chat actually spends.
 *
 * Composition root only: it wires configuration, data sources, the tracker and
 * the status bar together. All real work lives in src/.
 *
 * The single data source is the OpenTelemetry JSONL file that Copilot Chat can
 * export itself. Nothing here reads, patches, or depends on any file owned by
 * VS Code or by the Copilot extension.
 */

const vscode = require("vscode");
const path = require("path");

const events = require("./src/core/events");
const { UsageTracker } = require("./src/core/tracker");
const { OtelFileProvider } = require("./src/providers/otel-file");
const view = require("./src/ui/view");

const CONFIG_SECTION = "copilotOtelUsage";

let output;
let tracker;
let statusItem;
let providerStates = [];
let providers = [];
let reportDoc = null;
let lastContext = null;

function cfg() {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    statusBarFormat: c.get("statusBarFormat") || "lastDay",
    outfile: (c.get("outfile") || "").trim(),
    excludeModels: c.get("excludeModels") || [],
    pricing: c.get("pricing") || {},
  };
}

function log(msg) {
  if (output) output.appendLine(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${msg}`);
}

/** Apply the model exclude list before an event reaches the tracker. */
function isExcluded(model, patterns) {
  if (!patterns || !patterns.length) return false;
  const lower = String(model || "").toLowerCase();
  for (const p of patterns) {
    if (p && lower.includes(String(p).toLowerCase())) return true;
  }
  return false;
}

function rerender() {
  view.render(tracker, statusItem, providerStates, cfg());
}

function buildProviders() {
  const c = cfg();
  const onStatus = () => {
    providerStates = providers.map((p) => ({
      id: p.id,
      label: p.label,
      status: p.lastStatus || null,
    }));
  };

  const make = (p) => {
    // Wrap onStatus so the UI learns about provider health as it changes.
    const original = p.onStatus;
    p.onStatus = (s) => {
      p.lastStatus = s;
      if (original) original(s);
      onStatus();
    };
    return p;
  };

  return [
    make(
      new OtelFileProvider({
        filePath: c.outfile ? path.normalize(c.outfile) : "",
        log,
        onStatus: null,
      })
    ),
  ];
}

function stopProviders() {
  for (const p of providers) {
    try {
      if (typeof p.stop === "function") p.stop();
    } catch (e) {
      /* ignore */
    }
  }
  providers = [];
}

function startProviders() {
  stopProviders();
  providers = buildProviders();
  providerStates = providers.map((p) => ({ id: p.id, label: p.label, status: p.lastStatus || null }));
  for (const p of providers) {
    try {
      p.start();
    } catch (e) {
      log(`provider ${p.id} failed to start: ${e && e.message}`);
    }
  }
  providerStates = providers.map((p) => ({ id: p.id, label: p.label, status: p.lastStatus || null }));
}

// -------------------------------------------------------------- commands ----

async function diagnose() {
  tracker.rollDay();
  const c = cfg();
  const lines = [];
  lines.push(`时间          : ${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  lines.push(`扩展版本      : ${require("./package.json").version}`);
  lines.push(`存储文件      : ${tracker.storageFile}`);
  lines.push("");
  lines.push("--- 数据源 ---");
  for (const p of providers) {
    let d;
    try {
      d = typeof p.diagnose === "function" ? p.diagnose() : { id: p.id, label: p.label, state: "n/a", lines: [] };
    } catch (e) {
      d = { id: p.id, label: p.label, state: `diagnose 失败: ${e && e.message}`, lines: [] };
    }
    lines.push(`[${d.id}] ${d.label} — ${d.state}`);
    for (const l of d.lines || []) lines.push(`    ${l}`);
    lines.push("");
  }
  const s = tracker.state;
  lines.push("--- 统计 ---");
  lines.push(`今日请求      : ${s.day.calls}`);
  lines.push(`今日合计      : ${s.day.total} (输入 ${s.day.input} / 输出 ${s.day.output})`);
  lines.push(`被拒事件      : ${s.rejected}`);
  lines.push(`配置          : outfile=${c.outfile || "(空)"}`);

  let verdict;
  if (s.day.calls > 0) {
    verdict = `✅ 正常：已统计到 ${s.day.calls} 次请求。`;
  } else if (providers.some((p) => p.lastStatus && p.lastStatus.state === "ok")) {
    verdict = "⚠️ 数据源已连接，但还没有请求。在 Copilot Chat 里发一句话再看看。";
  } else if (!c.outfile) {
    verdict =
      "⚠️ 没有配置任何数据源。打开设置搜 copilotOtelUsage.outfile，填入 OTel JSONL 文件路径（同时需要在 Copilot 设置里打开 OTel 文件导出）。";
  } else {
    verdict = "⚠️ OTel 文件还没出现。确认已开启 github.copilot.chat.otel.enabled，并且重载过窗口。";
  }
  lines.push("", verdict);

  if (output) {
    output.appendLine("---------- diagnose ----------");
    for (const l of lines) output.appendLine(l);
    output.show(true);
  }
  vscode.window.showInformationMessage(verdict);
}

async function resetToday() {
  const ok = await vscode.window.showWarningMessage("重置今日 token 统计？", { modal: true }, "重置");
  if (ok !== "重置") return;
  tracker.reset();
  rerender();
  vscode.window.showInformationMessage("Copilot Token Usage：今日统计已重置");
}

async function toggleFormat() {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const order = ["lastDay", "last", "day", "cost"];
  const cur = c.get("statusBarFormat") || "lastDay";
  const next = order[(order.indexOf(cur) + 1) % order.length];
  await c.update("statusBarFormat", next, vscode.ConfigurationTarget.Global);
  rerender();
}

async function openReport() {
  const md = view.buildReport(tracker, providerStates, cfg().pricing);
  reportDoc = await vscode.workspace.openTextDocument({ content: md, language: "markdown" });
  await vscode.window.showTextDocument(reportDoc, { preview: false });
}

async function rescan() {
  // Re-scanning only means something if the sources are re-read from the start
  // AND what was already counted is forgotten. Otherwise the de-duplication store
  // swallows the replay and the command silently does nothing.
  tracker.reset(); // clears today's bucket and the remembered event ids
  events.resetDedupe(); // clears the in-memory store as well
  startProviders(); // providers restart at offset 0 -> full replay
  rerender();
  vscode.window.showInformationMessage(
    `Copilot Token Usage：已从数据源重新统计，今日 ${tracker.state.day.calls} 次请求 / ${tracker.state.day.total} tokens`
  );
}

// -------------------------------------------------------------- activate ----

function activate(context) {
  lastContext = context;
  output = vscode.window.createOutputChannel("Copilot Token Usage");
  const storageFile = path.join(context.globalStorageUri.fsPath, "usage.json");
  tracker = new UsageTracker(storageFile);

  // The OTel provider replays its file from byte 0 on every start so a reload
  // does not lose the day's tail. Restore the ids already counted, otherwise the
  // replay would add the whole file to today's bucket again.
  const seeded = events.seedDedupe(tracker.state.seenIds);
  if (seeded) log(`dedupe seeded with ${seeded} previously counted event id(s)`);

  statusItem = view.createStatusBar(context);

  events.onUsage((e) => {
    const c = cfg();
    if (isExcluded(e.model, c.excludeModels)) return;
    const rec = tracker.record(e);
    if (rec) {
      rerender();
      log(
        `${new Date(rec.t).toLocaleTimeString("zh-CN", { hour12: false })}  ${rec.model}  ` +
          `in=${rec.input} out=${rec.output} total=${rec.total}` +
          (rec.cached ? ` cached=${rec.cached}` : "") +
          (rec.reasoning ? ` reasoning=${rec.reasoning}` : "") +
          `  [${rec.source}]  | today=${tracker.state.day.total}`
      );
    }
  });

  tracker.subscribe(() => rerender());

  context.subscriptions.push(
    statusItem,
    output,
    vscode.commands.registerCommand("copilotOtelUsage.showDetails", () =>
      view.showDetails(tracker, providerStates, cfg().pricing)
    ),
    vscode.commands.registerCommand("copilotOtelUsage.diagnose", diagnose),
    vscode.commands.registerCommand("copilotOtelUsage.reset", resetToday),
    vscode.commands.registerCommand("copilotOtelUsage.toggleFormat", toggleFormat),
    vscode.commands.registerCommand("copilotOtelUsage.report", openReport),
    vscode.commands.registerCommand("copilotOtelUsage.rescan", rescan),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) return;
      if (e.affectsConfiguration(`${CONFIG_SECTION}.outfile`)) {
        startProviders();
      }
      rerender();
    }),
    new vscode.Disposable(() => {
      stopProviders();
      tracker.flush();
    })
  );

  startProviders();

  // Day rollover + clock refresh.
  const timer = setInterval(() => rerender(), 60 * 1000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));

  rerender();
  log(`Copilot Token Usage active. version=${require("./package.json").version} storage=${storageFile}`);
  for (const p of providers) log(`provider: ${p.id} (${p.label})`);
}

function deactivate() {
  stopProviders();
  if (tracker) tracker.flush();
  // The host disposes subscriptions itself; doing it here too makes the
  // extension cleanly deactivatable in a test harness.
  if (lastContext && Array.isArray(lastContext.subscriptions)) {
    for (const d of lastContext.subscriptions.splice(0)) {
      try {
        if (d && typeof d.dispose === "function") d.dispose();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

module.exports = {
  activate,
  deactivate,
  // Test seams used by test/activate.js to drive the real wiring headlessly.
  // Not part of the public API.
  get __providers() {
    return providers;
  },
  get __tracker() {
    return tracker;
  },
};
