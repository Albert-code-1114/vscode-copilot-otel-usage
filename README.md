# Copilot Token Usage

**See how many tokens GitHub Copilot Chat actually spends — live, in the VS Code
status bar, including the models you bring with your own API key
(BYOK / custom endpoint).**

No proxy to run. No file patched. No GitHub quota API.

> **Not affiliated with GitHub or Microsoft.** *GitHub*, *Copilot* and *Visual Studio
> Code* are trademarks of their respective owners, used here only to say what this
> extension works with.

```
$(pulse) 2.2K / 34.5K        ← this request / today
```

---

## Why this exists

Every message you send in Copilot Chat is an API request: what you send is billed
as **input tokens**, what the model writes back as **output tokens**. With
GitHub's own models that lands on your Copilot subscription quota. But the moment
you point a Custom Endpoint / BYOK entry at your own provider — DeepSeek, Qwen,
your company gateway — **that is your money**.

VS Code does show the tokens of the request you just made — in the context-window
widget at the bottom of the chat box — but only when your gateway returns `usage`,
and only for that one request. There is no total, no per-model split, and it is
gone the moment you send the next message.

Copilot Token Usage puts the number in the status bar:

- what this one request cost
- today's total, and how many requests it took
- which model is eating the budget
- how much prompt caching saved
- optionally, a rough cost estimate from a price list you supply

Click the status bar item for the full breakdown and the last 30 requests.

---

## Install

### 1. Let Copilot Chat export its own usage

Copilot Chat can export OpenTelemetry. One of its exporters writes to a file, and
that file contains the token usage of every model call. Add this to your
`settings.json`:

```jsonc
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.outfile": "C:\\Users\\you\\copilot-otel.jsonl"
}
```

> These are **application-scoped** settings: reload the window afterwards
> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → `Developer: Reload Window`).
>
> Environment variables work too and take precedence:
> `COPILOT_OTEL_ENABLED=true`, `COPILOT_OTEL_EXPORTER_TYPE=file`,
> `COPILOT_OTEL_FILE_EXPORTER_PATH=<path>`.

### 2. Point Copilot Token Usage at the same file

```jsonc
{
  "copilotOtelUsage.outfile": "C:\\Users\\you\\copilot-otel.jsonl"
}
```

The paths must match. The status bar starts moving as soon as a request finishes.

### 3. Optional — see money instead of tokens

```jsonc
{
  "copilotOtelUsage.pricing": {
    "deepseek": { "in": 0.27, "out": 1.10 },
    "gpt-4o":   { "in": 2.50, "out": 10.00 }
  },
  "copilotOtelUsage.statusBarFormat": "cost"
}
```

Keys are **model-name substrings** (case-insensitive, longest match wins); values
are **US dollars per million tokens**. Set `copilotOtelUsage.statusBarFormat` to `cost`
to show today's estimate instead of tokens.

> It is an order-of-magnitude estimate, not a bill. Subscription plans, cache
> discounts, batch discounts and tiered pricing are all outside its knowledge.

---

## Commands

| Command | What it does |
|---|---|
| `Copilot Token Usage: 查看用量明细` | Today's summary / per-model split / last 30 requests |
| `Copilot Token Usage: 诊断数据源` | Is the source connected, how much was read, why is it zero |
| `Copilot Token Usage: 导出 Markdown 报告` | A pasteable usage report |
| `Copilot Token Usage: 切换状态栏显示格式` | `this/today` → `this only` → `today only` → `cost` |
| `Copilot Token Usage: 重新扫描数据源` | Rebuild today from the source; no window reload needed |
| `Copilot Token Usage: 重置今日统计` | Clear today's counters |

> Command titles and UI text are currently **Chinese**. An English localization
> via `vscode.l10n` is a welcome contribution — see *Contributing* below.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `copilotOtelUsage.outfile` | `""` | Path to the Copilot Chat OTel JSONL file |
| `copilotOtelUsage.statusBarFormat` | `lastDay` | `lastDay` / `last` / `day` / `cost` |
| `copilotOtelUsage.excludeModels` | `[]` | Substring match on model name; e.g. exclude the utility model Copilot uses to title conversations |
| `copilotOtelUsage.pricing` | `{}` | Local price list for the cost estimate |

State lives in `globalStorage/<publisher>.copilot-otel-usage/usage.json`, one bucket per
day, and the last 14 days are kept.

---

## What the export file actually contains

This is the part worth reading if you intend to change the parser, because the
obvious assumptions are all wrong.

`github.copilot.chat.otel.exporterType: "file"` creates **three** file exporters
— spans, logs and metrics — all appending to the *same* path. So one file holds a
mixture of:

| What | Shape | Used? |
|---|---|---|
| **Log records** | flat object, `attributes` is a plain **object**, time in `hrTime`, ids under `spanContext` | **yes — this is the data source** |
| OTLP metric envelopes | `{ resource, scopeMetrics }` | ignored |
| `{}` | the span exporter's empty output | ignored |

The token counts live on the log records, and they are **log records, not
spans**: there is no top-level `name`, no `startTimeUnixNano`, no `kind`. A
parser written against the OTLP span shape reads exactly zero fields from them
and still "works" — it just reports nothing, or reports wall-clock timestamps
instead of the real ones.

Two more traps, both of which were real bugs here before they were tests:

1. **One call is written twice.** Each model call produces a
   `gen_ai.client.inference.operation.details` record *and* a
   `copilot_chat.agent.turn` record — in the **same span**, with **identical**
   token counts. De-duplicating on `traceId:spanId` alone counts one call once,
   which is right; but it also collapses genuinely different calls, because…
2. **A whole turn reuses one span.** Several distinct model calls can share a
   single `spanId`. In one measured session, 6 real calls shared 2 spans.
   De-duplicating on the span therefore loses two thirds of the traffic.

The id that works is `traceId:spanId:input:output`: identical for the twin
records of one call, different for different calls in the same span.

Two further behaviours worth knowing:

- The file is **replayed from byte 0** on every window reload, so the ids that
  were already counted are persisted in `usage.json` and fed back into the
  de-duplication store on activation. Without that, every reload re-adds the
  whole file to today's total.
- The file is **never rotated by Copilot**, so it accumulates across days. Events
  whose local date is not today are dropped instead of being folded into today.

## How it differs from the alternatives

| Approach | Where the data comes from | Live | Sees your BYOK models | Cost |
|---|---|---|---|---|
| **① GitHub quota extensions** | GitHub account API (premium requests) | yes | ❌ BYOK traffic never reaches GitHub | subscription quota only |
| **② Chat-session log parsers** | VS Code's on-disk chat session files | after the fact | ✅, estimated per message | private format, breaks on upgrade |
| **③ Local proxies** (LiteLLM, one-api, Helicone) | traffic actually flows through your proxy | yes, most accurate | ✅ most accurate | a service to run, endpoint config to change |
| **④ Raw OTel** | the same export this extension reads | yes | ✅ | you get data, not answers |
| **⑤ Copilot Token Usage** | ④, turned into a product | yes | ✅ | one setting + one extension |

The core claim: Copilot Token Usage **does not invent a new way to get the data — it turns
the OpenTelemetry that Copilot Chat already exports into something readable.**

It stays on the officially exported surface: it reads the GenAI semantic
convention fields (`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
`gen_ai.request.model`) and understands OTel log records, OTLP span envelopes and
raw SDK spans.

**It deliberately does not patch or hook Copilot.** The alternative — injecting an
instrumentation call into the bundled Copilot extension at the point where the
response is parsed — does yield the rawest possible numbers, but it means rewriting
a minified proprietary bundle that sits in a version-specific directory and is
replaced wholesale on every VS Code update, so every anchor breaks each time. The
official export carries the *same* `usage` from the *same* call, so there is nothing
to gain by going that way. This extension reads a file; it never modifies anything.

### Prior art

Worth knowing about, and different in kind:

- [`kafumanto/copilot-tokens`](https://github.com/kafumanto/copilot-tokens) — parses
  VS Code's on-disk chat session files and estimates cost per session (row ②).
- [`rajbos/github-copilot-token-usage`](https://github.com/rajbos/github-copilot-token-usage)
  — its CLI analyses local session files; the extension itself reports GitHub quota.
- [`UncleBats/github-copilot-token-usage`](https://github.com/UncleBats/github-copilot-token-usage)
  — estimated usage from the same kind of sources.

None of them read the export Copilot writes itself, which is the one place the
provider-reported `usage` for a **BYOK** request is available without a proxy.

---

## Development

```bash
git clone https://github.com/<you>/copilot-otel-usage
cd copilot-otel-usage

npm test     # 4 suites, 87 assertions, no VS Code required
npm run check  # node --check every .js file
```

| Suite | Covers |
|---|---|
| `test/parser.test.js` | all three record shapes, edge cases, id stability |
| `test/smoke.test.js` | provider → event bus → tracker, re-drain, append, truncation |
| `test/activate.test.js` | real `activate()` against a fake `vscode` module: command registration, status bar, diagnose |
| `test/otel.test.js` | twin records, shared spans, reload idempotency, date filter, exclude list, rescan |

`test/otel.test.js` builds its own synthetic export file in a temp directory, so
no real usage data is ever involved.

To debug the extension itself, open the folder in VS Code and press <kbd>F5</kbd>
for an Extension Development Host, configure both `otel` settings there and chat
normally.

Zero runtime dependencies: Node built-ins and the `vscode` API only.

## Known limitations

- **It counts, it does not bill.** The numbers are the `usage` the provider
  returned. If a gateway does not return `usage` in a streaming response, no
  local tool can conjure it — `诊断数据源` will say "file present, 0 records with
  usage" rather than pretend the answer is zero.
- **No GitHub subscription quota.** Premium requests are a different thing; see
  category ① above.
- **The JSONL only grows.** The extension reads, never deletes. Rotate or trim it
  yourself; if the file is truncated, the reader restarts from 0 and
  de-duplication keeps the count honest.
- **Cost is an estimate.** Cache discounts, tiered pricing and included
  subscription volume are not modelled.

## Contributing

Issues and PRs are welcome. The most useful things right now:

- an English localization (`vscode.l10n`, `package.nls.json`)
- a provider for metric envelopes / other OTel exporters
- reports of the export shape from other Copilot Chat versions — if a field name
  changes, `test/parser.test.js` is where to pin it down

## License

MIT — see [LICENSE](LICENSE).
