# Changelog

[Keep a Changelog](https://keepachangelog.com/) format; [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-26

First release.

### Added

- Status bar readout of **this request / today's total** tokens, in four formats
  (`lastDay`, `last`, `day`, `cost`).
- `otel-file` data source: reads the OpenTelemetry JSON Lines file that Copilot
  Chat can export itself (`github.copilot.chat.otel.*`).
  - Understands all three record shapes that can appear: OTel log records (what
    the file exporter actually writes), OTLP span envelopes, and raw SDK spans.
  - Incremental reads — only new bytes are parsed, the whole file is not re-scanned.
  - Per-call de-duplication id (`traceId:spanId:input:output`), persisted across
    window reloads, so replaying the file from byte 0 never double-counts.
  - Events whose local date is not today are discarded rather than folded into
    today's bucket.
- Details panel: today's summary, per-model split, last 30 requests.
- Markdown report export.
- `诊断数据源` command: per-source connection state, lines read, and a verdict
  explaining a zero.
- Optional local price list and cost estimation.
- Model exclusion by substring (e.g. the small utility model Copilot uses to
  title conversations).
- Offline test suite — 4 suites / 87 assertions, no VS Code required.

### Notes

- The extension reads only the officially exported surface. It does not patch,
  instrument, or modify VS Code or the Copilot extension.
- Command titles and UI text are Chinese in this release; see *Contributing* in
  the README if you want to add a localization.

[0.1.0]: https://github.com/XBingbing/copilot-otel-usage/releases/tag/v0.1.0
