"use strict";

const vscode = require("vscode");
const { fmt, fmtExact, timeOf, estimateCost } = require("../core/format");

/**
 * Everything the user actually looks at: the status bar item, its tooltip, the
 * detail picker, and the report document.
 *
 * The UI is deliberately dumb — it receives a tracker and re-renders from it.
 */

function createStatusBar(config) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  item.name = "Token Usage";
  item.command = "copilotOtelUsage.showDetails";
  void config;
  return item;
}

/** Tooltip: the "what is happening right now" surface. */
function buildTooltip(tracker, providerStates, pricing) {
  const md = new vscode.MarkdownString();
  md.supportHtml = false;
  md.appendMarkdown("**Token Usage**\n\n");

  const last = tracker.last;
  const state = tracker.state;

  if (!state.day.calls) {
    md.appendMarkdown("还没统计到任何请求。\n\n");
    const dead = providerStates.filter((p) => p.status && p.status.state !== "ok");
    if (dead.length === providerStates.length && dead.length > 0) {
      md.appendMarkdown("数据源都还没接上：\n\n");
      for (const p of dead) md.appendMarkdown(`- \`${p.id}\` — ${p.status.detail}\n`);
      md.appendMarkdown("\n跑 **Token Usage: 诊断** 看怎么接。\n\n");
    }
  }

  if (last) {
    md.appendMarkdown(`本次 \`${last.model}\`\n\n`);
    md.appendMarkdown(
      `- 输入 ${fmtExact(last.input)} · 输出 ${fmtExact(last.output)} · **合计 ${fmtExact(
        last.total
      )}**\n`
    );
    if (last.cached || last.reasoning) {
      md.appendMarkdown(`- 缓存命中 ${fmtExact(last.cached)} · 推理 ${fmtExact(last.reasoning)}\n`);
    }
    md.appendMarkdown("\n");
  }

  const d = state.day;
  md.appendMarkdown(`今日累计 (${state.date})：**${fmtExact(d.total)}** / ${d.calls} 次\n\n`);
  if (d.calls) {
    md.appendMarkdown(`- 输入 ${fmtExact(d.input)} · 输出 ${fmtExact(d.output)}\n`);
    if (d.cached) md.appendMarkdown(`- 缓存命中 ${fmtExact(d.cached)}\n`);
  }

  const models = tracker.modelsByTotal();
  if (models.length) {
    md.appendMarkdown("\n按模型：\n\n");
    for (const [name, m] of models.slice(0, 8)) {
      const cost = estimateCost(Object.assign({ model: name }, m), pricing);
      const costText = cost === null ? "" : ` · ≈$${cost.toFixed(4)}`;
      md.appendMarkdown(`- \`${name}\` — ${fmt(m.total)}（${m.calls} 次）${costText}\n`);
    }
  }

  md.appendMarkdown("\n点击查看明细");
  return md;
}

function render(tracker, statusItem, providerStates, cfg) {
  if (!tracker || !statusItem) return;
  tracker.rollDay();
  const state = tracker.state;
  const last = tracker.last;

  const live = providerStates.filter((p) => p.status && p.status.state === "ok");
  if (!live.length && !state.day.calls) {
    statusItem.text = "$(circle-slash) 无数据源";
    statusItem.tooltip = buildTooltip(tracker, providerStates, cfg.pricing);
    statusItem.show();
    return;
  }

  const mode = cfg.statusBarFormat || "lastDay";
  const lastTotal = last ? last.total : 0;
  const dayTotal = state.day.total;
  let text;
  if (mode === "last") text = `$(pulse) ${fmt(lastTotal)}`;
  else if (mode === "day") text = `$(pulse) ${fmt(dayTotal)}`;
  else if (mode === "cost") {
    const cost = estimateCost({ model: last ? last.model : "", ...state.day }, cfg.pricing);
    text = `$(pulse) ${cost === null ? "无定价" : "$" + cost.toFixed(3)}`;
  } else text = `$(pulse) ${fmt(lastTotal)} / ${fmt(dayTotal)}`;

  statusItem.text = text;
  statusItem.tooltip = buildTooltip(tracker, providerStates, cfg.pricing);
  statusItem.show();
}

async function showDetails(tracker, providerStates, pricing) {
  tracker.rollDay();
  const state = tracker.state;
  const d = state.day;
  const items = [];

  const cost = estimateCost({ model: "", ...d }, pricing);
  items.push({
    label: "$(calendar) 今日累计",
    description: `${fmtExact(d.total)} tokens`,
    detail:
      `输入 ${fmtExact(d.input)} · 输出 ${fmtExact(d.output)} · 缓存 ${fmtExact(d.cached)} · 推理 ${fmtExact(
        d.reasoning
      )} · ${d.calls} 次请求` + (cost === null ? "" : ` · 估算 $${cost.toFixed(4)}`),
  });

  const prev = tracker.previousDay();
  if (prev) {
    items.push({
      label: `$(history) ${prev.date}`,
      description: `${fmtExact(prev.bucket.total)} tokens`,
      detail: `${prev.bucket.calls} 次请求 · 输入 ${fmtExact(prev.bucket.input)} · 输出 ${fmtExact(
        prev.bucket.output
      )}`,
    });
  }

  for (const [name, m] of tracker.modelsByTotal()) {
    const c = estimateCost(Object.assign({ model: name }, m), pricing);
    items.push({
      label: `$(symbol-method) ${name}`,
      description: `${fmtExact(m.total)} tokens`,
      detail: `输入 ${fmtExact(m.input)} · 输出 ${fmtExact(m.output)} · 缓存 ${fmtExact(m.cached)} · ${
        m.calls
      } 次` + (c === null ? "" : ` · 估算 $${c.toFixed(4)}`),
    });
  }

  if (state.recent.length) {
    items.push({ label: "最近请求", kind: vscode.QuickPickItemKind.Separator });
    for (const r of state.recent.slice(0, 30)) {
      items.push({
        label: `$(history) ${timeOf(r.t)}  ${r.model}`,
        description: `${fmtExact(r.total)} tokens`,
        detail: `输入 ${fmtExact(r.input)} · 输出 ${fmtExact(r.output)}` +
          (r.cached ? ` · 缓存 ${fmtExact(r.cached)}` : "") +
          (r.reasoning ? ` · 推理 ${fmtExact(r.reasoning)}` : "") +
          ` · 来源 ${r.source}`,
      });
    }
  }

  items.push({ label: "操作", kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: "$(pulse) 诊断数据源", description: "copilotOtelUsage.diagnose" });
  items.push({ label: "$(output) 导出报告", description: "copilotOtelUsage.report" });
  items.push({ label: "$(trash) 重置今日统计", description: "copilotOtelUsage.reset" });

  const picked = await vscode.window.showQuickPick(items, {
    title: `Token Usage — ${state.date}`,
    placeHolder: `今日 ${fmtExact(d.total)} tokens / ${d.calls} 次请求`,
    matchOnDetail: true,
  });
  if (!picked) return;
  if (picked.label.startsWith("$(trash)")) await vscode.commands.executeCommand("copilotOtelUsage.reset");
  else if (picked.label.startsWith("$(pulse)")) await vscode.commands.executeCommand("copilotOtelUsage.diagnose");
  else if (picked.label.startsWith("$(output)")) await vscode.commands.executeCommand("copilotOtelUsage.report");
}

/** Markdown report: for pasting into an issue or a cost review. */
function buildReport(tracker, providerStates, pricing) {
  const state = tracker.state;
  const d = state.day;
  const lines = [];
  lines.push(`# Token Usage — ${state.date}`);
  lines.push("");
  lines.push(`- 今日合计：**${fmtExact(d.total)}** tokens / ${d.calls} 次请求`);
  lines.push(`- 输入 ${fmtExact(d.input)} · 输出 ${fmtExact(d.output)} · 缓存 ${fmtExact(d.cached)} · 推理 ${fmtExact(d.reasoning)}`);
  const cost = estimateCost({ model: "", ...d }, pricing);
  if (cost !== null) lines.push(`- 估算成本：$${cost.toFixed(4)}（按本地定价表，仅供参考）`);
  lines.push("");
  lines.push("## 按模型");
  lines.push("");
  lines.push("| 模型 | 合计 | 输入 | 输出 | 缓存 | 次数 | 估算 |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const [name, m] of tracker.modelsByTotal()) {
    const c = estimateCost(Object.assign({ model: name }, m), pricing);
    lines.push(
      `| \`${name}\` | ${m.total} | ${m.input} | ${m.output} | ${m.cached} | ${m.calls} | ${
        c === null ? "—" : "$" + c.toFixed(4)
      } |`
    );
  }
  lines.push("");
  lines.push("## 数据源");
  lines.push("");
  for (const p of providerStates) {
    lines.push(`- \`${p.id}\` (${p.label}) — ${p.status ? p.status.state : "unknown"}`);
  }
  lines.push("");
  lines.push("## 最近请求");
  lines.push("");
  lines.push("| 时间 | 模型 | 输入 | 输出 | 合计 | 来源 |");
  lines.push("|---|---|---:|---:|---:|---|");
  for (const r of state.recent.slice(0, 50)) {
    lines.push(`| ${timeOf(r.t)} | \`${r.model}\` | ${r.input} | ${r.output} | ${r.total} | ${r.source} |`);
  }
  lines.push("");
  return lines.join("\n");
}

module.exports = { createStatusBar, render, showDetails, buildTooltip, buildReport };
