# Copilot Token Usage（中文说明）

**在 VS Code 状态栏里实时看见 Copilot Chat 到底花了多少 token —— 包括你用自己的
API Key 接进来的模型（BYOK / Custom Endpoint）。**

不用跑代理，不用改任何文件，不碰 GitHub 的额度接口。

> **与 GitHub、Microsoft 无隶属关系。** *GitHub*、*Copilot*、*Visual Studio Code*
> 是各自所有者的商标，这里只用来说明本扩展适用于什么。

```
$(pulse) 2.2K / 34.5K        ← 本次请求 / 今日累计
```

英文完整文档见 [README.md](README.md)。

---

## 为什么需要它

你在 Copilot Chat 里问一句话，背后是一次 API 请求：发过去的内容算「输入 token」，
模型回给你的算「输出 token」。用 GitHub 官方模型时，这笔账记在订阅额度里；但你用
Custom Endpoint 接了自己的模型（DeepSeek、Qwen、自建网关……），**花的是你自己的
钱**。

VS Code 其实**会**显示你刚发那一次的 token 数——就在聊天框下方那个上下文窗口指示器
里——但前提是你的网关返回了 `usage`，而且只显示那一次。没有累计、没有按模型拆分，
你一发下一句它就没了。

Copilot Token Usage 就是把那个数字摆到状态栏上：

- 这一句话花了多少
- 今天一共花了多少、跑了几次
- 哪个模型吃得多
- 缓存命中省下了多少
- （可选）按你自己填的单价，换算成大概多少钱

点一下状态栏，能看到全部明细和最近 30 条请求。

---

## 安装

### 第 1 步：把扩展装进 VS Code

还没上 Marketplace，所以得手动装。VS Code 会加载扩展目录里任何名字形如
`<publisher>.<name>-<version>` 的文件夹。

**Windows**

```powershell
git clone https://github.com/Albert-code-1114/vscode-copilot-otel-usage
Move-Item .\vscode-copilot-otel-usage "$env:USERPROFILE\.vscode\extensions\xbingbing.copilot-otel-usage-0.1.0"
```

**macOS / Linux**

```bash
git clone https://github.com/Albert-code-1114/vscode-copilot-otel-usage
mv vscode-copilot-otel-usage ~/.vscode/extensions/xbingbing.copilot-otel-usage-0.1.0
```

然后重载窗口（<kbd>Ctrl</kbd>+<kbd>R</kbd>）。

想一键安装：`npx @vscode/vsce package` 打出 `.vsix`，再用命令面板的
**Extensions: Install from VSIX…** 装。

> **不要**复制进 VS Code 自己的 `resources/app/extensions` 目录——那个目录每次升级都被
> 整体替换，扩展会跟着消失。上面那个用户级扩展目录不会。

### 第 2 步：让 Copilot Chat 把它自己的用量导出成文件

Copilot Chat 内置了 OpenTelemetry 导出能力，其中 `file` 导出器会把每次模型调用的
token 用量写进一个文件。在 `settings.json` 里加：

```jsonc
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.outfile": "C:\\Users\\你的用户名\\copilot-otel.jsonl"
}
```

> 这几个设置是 **application 作用域**，改完**需要重载窗口**
> （<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → `Developer: Reload Window`）。
>
> 也可以用环境变量（优先级更高）：`COPILOT_OTEL_ENABLED=true`、
> `COPILOT_OTEL_EXPORTER_TYPE=file`、`COPILOT_OTEL_FILE_EXPORTER_PATH=<路径>`。

### 第 3 步：把同一个路径告诉 Copilot Token Usage

```jsonc
{
  "copilotOtelUsage.outfile": "C:\\Users\\你的用户名\\copilot-otel.jsonl"
}
```

两个路径一致即可，下一次请求结束状态栏就会动。

### 第 4 步（可选）：填个价目表，看钱

```jsonc
{
  "copilotOtelUsage.pricing": {
    "deepseek": { "in": 0.27, "out": 1.10 },
    "gpt-4o":   { "in": 2.50, "out": 10.00 }
  },
  "copilotOtelUsage.statusBarFormat": "cost"
}
```

键是**模型名子串**（不区分大小写，取最长匹配），值是**每 100 万 token 的美元单价**。
把 `copilotOtelUsage.statusBarFormat` 设为 `cost`，状态栏就直接显示今日估算花费。

> 估算是给你做量级判断用的，不是账单。订阅套餐、缓存折扣、批处理折扣、阶梯价都不在
> 里面。

---

## 命令

| 命令 | 作用 |
|---|---|
| `Copilot Token Usage: 查看用量明细` | 今日汇总 / 按模型拆分 / 最近 30 条 |
| `Copilot Token Usage: 诊断数据源` | 数据源连上没有、读了多少行、为什么是 0 |
| `Copilot Token Usage: 导出 Markdown 报告` | 生成可粘贴的用量报告 |
| `Copilot Token Usage: 切换状态栏显示格式` | `本次/今日` → `只看本次` → `只看今日` → `估算成本` |
| `Copilot Token Usage: 重新扫描数据源` | 从数据源重建今日统计，不用重载窗口 |
| `Copilot Token Usage: 重置今日统计` | 清空今天的累计 |

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `copilotOtelUsage.outfile` | `""` | Copilot Chat OTel JSONL 文件路径 |
| `copilotOtelUsage.statusBarFormat` | `lastDay` | `lastDay` / `last` / `day` / `cost` |
| `copilotOtelUsage.excludeModels` | `[]` | 按模型名子串排除，例如把 Copilot 用来起标题的小模型踢掉 |
| `copilotOtelUsage.pricing` | `{}` | 本地价目表，用于估算成本 |

数据落在 `globalStorage/<publisher>.copilot-otel-usage/usage.json`，按天存，保留最近 14 天。

---

## 导出文件里到底有什么（改解析器前必读）

`github.copilot.chat.otel.exporterType: "file"` 会创建**三个**文件导出器 —— span、
log、metric —— 而它们**追加写入同一个路径**。所以一个文件里混着三种东西：

| 内容 | 形态 | 是否使用 |
|---|---|---|
| **Log record** | 扁平对象，`attributes` 是普通**对象**，时间在 `hrTime`，id 在 `spanContext` | **是，这就是数据源** |
| OTLP 指标信封 | `{ resource, scopeMetrics }` | 忽略 |
| `{}` | span 导出器的空输出 | 忽略 |

token 数在 log record 上，而它是 **log record，不是 span**：没有顶层 `name`、没有
`startTimeUnixNano`、没有 `kind`。照 OTLP span 形态写的解析器从它身上读不到任何字段，
却依然"能跑"——只是什么都报不出来，或者把时间戳报成读取时刻而不是真实时刻。

还有两个坑，都曾经是这里的真 bug，后来才变成测试：

1. **一次调用会被写两遍。** 每次模型调用会产出一条
   `gen_ai.client.inference.operation.details` 记录**和**一条
   `copilot_chat.agent.turn` 记录，二者在**同一个 span 里**、token 数**完全相同**。
2. **一整轮对话共用一个 span。** 几次不同的模型调用可能共享同一个 `spanId` ——
   实测出现过 6 次真实调用只对应 2 个 span。只按 `traceId:spanId` 去重，会把 6 次
   压成 2 次，少算三分之二。

能用的 id 是 `traceId:spanId:输入:输出`：同一次调用的两条记录相同，同一 span 里的不同
调用不同。

另外两个行为值得知道：

- 每次重载窗口，文件都会**从第 0 字节重放**。所以已经计过的 id 会持久化进
  `usage.json`，激活时回灌给去重表。否则每重载一次，今天的数字就会再加一遍整个文件。
- Copilot **不会轮转**这个文件，它会跨天一直变长。日期不是今天的事件会被丢弃，而不是
  被折进今天的账里。

## 它和别的方案有什么不一样

| 方案 | 数据从哪来 | 实时性 | 看你自己的 BYOK 模型 | 代价 |
|---|---|---|---|---|
| **① GitHub 额度类扩展** | GitHub 账号接口（premium request） | 准 | ❌ BYOK 请求不经过 GitHub 服务器 | 只能看订阅额度 |
| **② 会话日志解析类** | VS Code 落盘的 chat session 文件 | 事后 | ✅ 但按会话/消息估算 | 解析私有格式，升级易碎 |
| **③ 本地代理类**（LiteLLM / one-api / Helicone） | 请求真的从你本地代理过 | 实时且最准 | ✅ 最准 | 要跑一个常驻服务、改 endpoint |
| **④ 直接用官方 OTel** | 与本扩展同一个导出 | 实时 | ✅ | 有数据，没结论 |
| **⑤ Copilot Token Usage** | ④，变成产品 | 实时 | ✅ | 一行配置 + 一个扩展 |

核心区别就一句：Copilot Token Usage **不发明新的取数方式，而是把官方已经导出的
OpenTelemetry 数据变成能看的东西。**

它只用官方导出的字段（`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、
`gen_ai.request.model`），并且同时认得 OTel log record、OTLP span 信封和原始 SDK
span 三种形态。

**它刻意不给 Copilot 打补丁。** 另一条路子是往 Copilot 扩展本体里、解析响应那行代码
旁边插一句埋点，确实能拿到最原始的数字；但那意味着要改写一份压缩混淆过的专有 bundle，
它躺在按版本号命名的目录里、每次 VS Code 升级都被整体替换，锚点每次都会失效。官方导出
带的是**同一次调用的同一个 `usage`**，走那条路并没有多拿到什么。本扩展只读文件，
不修改任何东西。

### 已有的同类项目，以及真正重要的那条区别

这个方向已经有好几个做得不错的工具，值得点名。它们和本扩展的区别不是口味问题：

| 项目 | 它到底是什么 | 数字从哪来 |
|---|---|---|
| [`kafumanto/copilot-tokens`](https://github.com/kafumanto/copilot-tokens) | 命令行 / 容器镜像。按会话、按模型出表，可导出 JSON 或 CSV，用 OpenRouter 价目算钱 | 用 `o200k_base` 分词器把 VS Code 会话文件里落盘的文本**重新数一遍** —— 是**估算**。它自己的 README 说得很坦率：这些计数「不包含隐藏的系统提示词、服务端拼装的上下文，以及任何没有写进磁盘的 Copilot 内部 token」 |
| [`rajbos/ai-engineering-fluency`](https://github.com/rajbos/ai-engineering-fluency)（原名 `github-copilot-token-usage`） | Marketplace 扩展 + 命令行。状态栏、仪表盘、可选云同步，支持一大堆工具（Copilot、Claude Code、Gemini CLI、Continue……） | 各个工具自己的本地会话日志 —— 同样是"数文本"的估算路子 |
| [`UncleBats/github-copilot-token-usage`](https://github.com/UncleBats/github-copilot-token-usage) | 显示估算用量的 VS Code 扩展 | 同一类本地来源 |
| **Copilot Token Usage** | 状态栏 + 面板，一行配置 | Copilot Chat 自己写进 **OTel 导出**的 `gen_ai.usage.*` 字段 —— 也就是 endpoint 针对那一次请求返回的数字 |

**「估算」和「上报」的差别就是全部。** 数磁盘上恰好存在的文本，得到的是"本地看得见的部分"
推出来的数。它看不到系统提示词、工具 schema、检索进来的上下文，以及请求离开你机器之后
服务端拼装的任何东西 —— 而在 agentic 对话里，恰恰是这看不见的部分占了输入的大头，所以
按可见文本估算通常会严重低估输入。读 `gen_ai.usage.input_tokens` 拿到的，是 endpoint
自己数出来、并且据此计费的那个数。

这个区别也正是本扩展存在的理由。对**订阅制** Copilot 用户来说它几乎不重要——GitHub 官方
的额度界面就是权威，看额度的扩展也有一堆。但 BYOK 的流量根本不经过 GitHub，GitHub 没有
任何东西可以给你看，唯一诚实的来源就是那个真正计费的 endpoint。而它把数字写进了 OTel 导出。

---

## 开发

```bash
git clone https://github.com/Albert-code-1114/vscode-copilot-otel-usage
cd vscode-copilot-otel-usage

npm test       # 4 个套件、87 项断言，不需要启动 VS Code
npm run check  # 对每个 .js 跑 node --check
```

| 套件 | 覆盖内容 |
|---|---|
| `test/parser.test.js` | 三种记录形态、边界情况、id 稳定性 |
| `test/smoke.test.js` | 数据源 → 事件总线 → tracker、重复 drain、追加、截断 |
| `test/activate.test.js` | 用假的 `vscode` 模块真实执行 `activate()`：命令注册、状态栏、诊断 |
| `test/otel.test.js` | 双子记录、共享 span、重载幂等、日期过滤、排除名单、重新扫描 |

`test/otel.test.js` 自己生成合成导出文件到临时目录，不涉及任何真实用量数据。

要调试扩展本体：用 VS Code 打开这个文件夹，按 <kbd>F5</kbd> 启动 Extension
Development Host，在那边把两个 `otel` 设置配上，然后正常聊天。

零运行时依赖，纯 Node 内置模块 + `vscode` API。

## 已知限制

- **只统计，不计费。** 数字来自 provider 返回的 `usage`。如果某个网关在流式响应里根本
  不返回 `usage`，那谁都变不出来 —— 这时 `诊断数据源` 会告诉你「文件存在但 0 条含用量
  的记录」，而不是假装 0。
- **不含 GitHub 订阅额度。** 那是另一套东西（premium requests），请看 ① 类扩展。
- **JSONL 会一直长。** 本扩展只读不删，你可以自己定期清理或轮转；文件被截断后会自动从
  0 重读，靠 id 去重，不会重复计数。
- **成本是估算。** 缓存折扣、阶梯价、订阅包含量都不算。

## 参与贡献

欢迎提 issue 和 PR。目前最有价值的方向：

- 英文界面本地化（`vscode.l10n`、`package.nls.json`）
- 针对指标信封 / 其它 OTel 导出器的数据源
- 其它 Copilot Chat 版本的导出形态报告 —— 如果字段名变了，
  `test/parser.test.js` 就是把它钉下来的地方

## License

MIT —— 见 [LICENSE](LICENSE)。
