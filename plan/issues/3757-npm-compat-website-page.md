---
id: 3757
title: "npm package compatibility website page — compile/validate/test/perf head-to-head for every tests/dogfood/ package"
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: medium
horizon: l
feasibility: easy
reasoning_effort: medium
task_type: feature
area: website
language_feature: n/a
goal: core-semantics
origin: "user request: add an npm compatibility page to the website showing which packages compile, how many of their unit tests pass, and head-to-head performance vs Node"
related: [1710, 3716, 3729, 3747, 3748, 3749, 3750, 3751, 3756]
---

# #3757 — npm compatibility website page

## What changed

- `scripts/generate-npm-compat-report.mjs` — new committed-artifact
  generator (mirrors `scripts/generate-playground-benchmark-sidebar.mjs`'s
  convention): reuses each `tests/dogfood/*-harness.mjs`'s existing
  `runHarness()` export for compile/validate/differential-correctness
  data (no duplicated logic), and adds ONE new thing on top — a
  head-to-head perf comparison of the compiled Wasm export against the
  SAME pinned package running natively under Node (not a synthetic
  micro-benchmark, unlike the playground sidebar which compares Wasm
  against the same source transpiled to plain JS). Perf compiles with
  `optimize: 4` so the numbers reflect a realistic deployment, not the
  debug-friendly unoptimized binary the correctness harnesses use.
  Writes `benchmarks/results/npm-compat.json` (committed — added to the
  `.gitignore` allowlist alongside the other curated benchmark JSON) and
  mirrors it to `website/public/benchmarks/results/`.
- `website/components/npm-compat-chart.js` — new Web Component
  (`<npm-compat-chart src="...">`), same fetch-at-runtime convention as
  `t262-charts.js`/`trend-chart.js`/`perf-benchmark-chart.js` — no
  build-time templating. Renders one card per package: compile/validate
  badges, test results (explicitly labeled "own test suite" vs
  "differential ops (not the package's own tests)" — never conflated),
  perf ratio, and linked known-bug issues.
- `website/public/npm-compat.html` — the page itself, dark-theme
  standalone HTML matching `benchmarks/results/report.html`'s styling,
  with an explanatory "how to read this" box up front.
- `website/index.html` — links to the new page (hero button + footer
  nav entry), next to the existing "Compatibility Test Report" link.
- `scripts/build-pages.js` — copies `npm-compat.html` and the preferred
  `npm-compat.json` source (canonical `benchmarks/results/` over the
  `website/public/` mirror) into `dist/pages`, same pattern as
  `report.html`/`history.json`/`latest.json`.
- `package.json` — `pnpm run generate:npm-compat` script.

## Scope: only packages with a committed, reproducible harness

Deliberately limited to acorn, marked, clsx, cookie (each has a real
`tests/dogfood/*-harness.mjs`). mustache (#3720), diff (#3721), and
dayjs (#3747) were probed ad-hoc and surfaced real bugs, but have no
committed harness — NOT included here rather than fabricating numbers
from a one-off, non-reproducible probe. The page's `note` field and the
`tests/dogfood/README.md` "dayjs" section both explain this gap
honestly.

## A significant new finding from the perf measurement

Timing acorn's compiled `parse()` against its own real dist bundle
(226KB) turned up a ~400x slowdown vs native — much larger than the
already-known and already-fixed ~9.5x "tokenizer axis" constant-factor
cost (loopdive/js2#3715/#3739). Isolated with a clean, acorn-independent
scaling benchmark (a fixed snippet repeated at 4 size points): the
compiled/native ratio **grows** with input size (14x at 4.9KB → 424x at
313KB) rather than staying constant, meaning this is a genuinely
super-linear scaling problem, not just per-call overhead. Filed
separately as **#3756**, not fixed here (`feasibility: hard`) — this
harness's job was to surface it via a real head-to-head measurement,
same as every other dogfood finding this session.

## Permanent test reference

The page's underlying data is only as good as the harnesses that produce
it — those are already pinned by permanent, existing tests:
`tests/dogfood/clsx.test.ts` and `tests/dogfood/cookie.test.ts` (both
opt-in, `DOGFOOD_CLSX=1`/`DOGFOOD_COOKIE=1`) gate on the exact op-diff
counts the new generator reuses via each harness's `runHarness()`. No
new test file for this issue specifically — the website page/generator
script is presentation-layer glue over data those tests already pin.

## Acceptance criteria

- [x] `pnpm run generate:npm-compat` regenerates a committed,
      structured summary covering all 4 packages with the harness's own
      correctness data plus a real head-to-head perf number.
- [x] Website page renders the data, clearly distinguishing "own test
      suite" results from "differential ops" results, with every known
      bug linked to its issue.
- [x] The one new finding from perf measurement (#3756) is filed
      properly, not glossed over or hidden to make the numbers look
      better.
- [x] `build:pages` wiring copies both the page and its data into the
      deployed site output.
