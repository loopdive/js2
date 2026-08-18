---
id: 3904
title: "perf-bench: all four dom/* benchmarks publish a JS-only bar — the wasm lane fails silently and the page shows nothing"
status: done
created: 2026-07-31
updated: 2026-08-18
completed: 2026-07-31
assignee: ttraenkler/issue-3904-dom-bench
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: testing
language_feature: dom
goal: performance
sprint: 78
horizon: m
es_edition: n/a
related: [3902, 3903, 1009]
---

# #3904 — the `dom/*` benchmarks have no wasm lane at all on the public page

## Status: done — lane fixed (outcome 1 of the two acceptable outcomes)

## Problem

`benchmarks/results/latest.json` (2026-07-31) contains **only a `js` entry**
for all four DOM benchmarks:

```
dom/create-elements    js
dom/set-attributes     js
dom/read-attributes    js
dom/modify-text        js
```

Every other benchmark in the file has 2-4 strategies. These four have one. So
on `https://js2.loopdive.com/benchmarks/performance.html` the DOM section
either renders an empty chart or a lone JS bar with nothing to compare it to.

`benchmarks/suites/dom.ts` deliberately skips `gc-native` and `linear-memory`
("DOM always needs host calls" — reasonable, DOM is inherently host interop).
That leaves **`host-call`, which is not skipped and should be running**. It is
producing no result, which means it is failing and being swallowed.

## Why it is invisible

`benchmarks/harness.ts` downgrades any strategy failure to a skip in three
places — setup (`:168-177`), calibration (`:198-202`), and mid-loop
(`:219-223`). Each writes a line to **stderr** and returns `null`. The result
never reaches `latest.json`, so the chart simply omits the bar. A reader
cannot distinguish "this lane is not applicable" from "this lane crashed".

This is the same swallowing that hides the missing `array/sort-i32` gc-native
lane (#3902) — coordinate on the harness fix rather than doing it twice.

## Reproduce

```bash
npx tsx benchmarks/run.ts --suite dom --strategy js,host-call
```

and read stderr for the `[host-call skipped: …]` line. (Note: the repo needs
`pnpm install` first — a bare `npx tsx` fails with
`Cannot find package 'typescript'`, which is not the bug being investigated.)

## Scope

1. **Get the actual error.** Do not guess. It could be the DOM stub
   `deps`/`extraEnv` wiring in `benchmarks/suites/dom.ts`, a compile failure
   on the DOM source strings, or a runtime trap on first call.
2. **Fix it** so the four DOM benchmarks publish a real `host-call` bar, or —
   if the DOM stubs are fundamentally not runnable in the Node harness —
   remove the benchmarks from the published page rather than shipping four
   meaningless single-bar charts. Either outcome is acceptable; silently
   publishing nothing is not.
3. **Surface future failures.** A failed strategy must appear in the results
   JSON with its error (e.g. `{strategy, status: "failed", error}`) so the page
   can render "lane failed" and the next person does not have to run the suite
   by hand to discover a lane has been dead for months. Coordinate with #3902,
   which needs the identical change — whoever lands first, the other rebases.
4. **Once it runs, report the numbers.** DOM is pure host interop, so expect
   this lane to be slow; that is fine and expected. The point is publishing an
   honest bar, not winning. If it is catastrophically slow in the way #3903
   describes, cross-reference it there.

## Acceptance criteria

1. The `[host-call skipped: …]` error for all four DOM benchmarks is recorded
   verbatim in this issue.
2. Either all four publish a working `host-call` result in
   `benchmarks/results/latest.json`, or they are removed from the page with the
   reason documented here.
3. Failed strategies are represented in the results JSON with an error string
   instead of being omitted entirely.
4. The performance page renders sensibly in whichever of the two outcomes
   applies — no empty chart cards.

## Non-goals

- Optimising DOM interop performance. Get an honest bar first; optimisation is
  a separate issue filed from the resulting number.
- The offline-first Playwright DOM measurement work tracked elsewhere — this
  issue is about the existing Node-harness lane failing silently.

---

## Findings

### 1. The verbatim error (AC 1)

`npx tsx benchmarks/run.ts --suite dom --strategy js,host-call`, on
`c17ac7cf`, Node v22.22.2, linux x64. **All four** benchmarks emit the
*identical* line:

```
=== Suite: dom ===

  dom/create-elements ...
    [host-call skipped (runtime): Cannot read properties of undefined (reading 'createElement')]
 js: 0.098ms
  dom/set-attributes ...
    [host-call skipped (runtime): Cannot read properties of undefined (reading 'createElement')]
 js: 0.233ms
  dom/read-attributes ...
    [host-call skipped (runtime): Cannot read properties of undefined (reading 'createElement')]
 js: 0.114ms
  dom/modify-text ...
    [host-call skipped (runtime): Cannot read properties of undefined (reading 'createElement')]
 js: 0.121ms
```

Note `(runtime)`, not a bare `skipped:` — the modules **compiled and
instantiated fine** and trapped on the very first warmup call. This ruled out
the "compile failure on the DOM source strings" hypothesis immediately.

### 2. Root cause

Stack trace from a probe that instantiates `dom/create-elements` by hand:

```
TypeError: Cannot read properties of undefined (reading 'createElement')
    at src/runtime.ts:8308:34          <- extern_class Document.createElement: (self, tag) => self.createElement(tag)
    at fn (src/runtime.ts:15633:27)    <- the host-import recursion guard
    at run (wasm://wasm/c44261de:wasm-function[3]:0x16c)
```

`self` — the Document handle — was `undefined`. Each DOM module declares three
imports:

```
["env.global_document", "env.Document_createElement", "env.Element_appendChild"]
```

`env.global_document` is a **`declared_global` intent**, and
`resolveImport` (`src/runtime.ts:15126`) resolves it by the *global's own
name*:

```ts
case "declared_global": {
  const val = deps?.[intent.name];        // deps.document  <- MISSING
  if (val !== undefined) return () => val;
  const g = globalSandbox ?? globalThis;
  const ambient = g[intent.name];         // globalThis.document — Node has none
  if (ambient !== undefined) return () => ambient;
  return () => {};                        // <- returns undefined
}
```

`benchmarks/suites/dom.ts` passed `deps: { Document: MockDocument, Element:
MockElement }` — the extern **classes**, which satisfy the `Document_*` /
`Element_*` imports but say nothing about the `document` *global*. There was
no `document` key, Node has no ambient `document`, so the import fell through
to the `() => {}` stub and the module received `undefined`.

The wiring the author *intended* was the `extraEnv: { __get_document: () =>
mockDoc }` block on each def — but **`extraEnv` was never read anywhere**. It
was declared on `BenchmarkDef` and set four times; `runStrategy` only ever
passes `def.deps` to `buildImports`. Dead field, dead import name
(`__get_document` is not an import the compiler emits). Removed rather than
left as a trap.

### 3. Why it stayed invisible for months

`benchmarks/harness.ts` downgraded every strategy failure to `return null` in
four places (setup, warmup, calibration, mid-loop). `runBenchmark` dropped the
null, so the row never reached `latest.json`, and
`website/components/perf-benchmark-chart.js` (`mode="benchmark-runtime"`)
filters to `row.medianMs > 0` → `ratios` empty → `this.style.display =
"none"`. The chart element **hides itself entirely**, so the DOM cards
rendered a code snippet with no chart at all. A missing bar was
indistinguishable from `skip: ["gc-native", "linear-memory"]`, i.e. from "not
applicable".

### 4. What the silence was actually hiding — this is not reporting hygiene

The natural way to describe this issue is "four charts render wrong". That
undersells it, and the undersell is the reason it survived. The silent-drop
behaviour is not confined to the DOM suite: it applies to **every strategy of
every benchmark**, and it drops precisely the failures that are hardest to
tell apart from a deliberate skip.

Measured here (probe pattern in `.tmp/`, each case returns a **number** so the
result cannot be confounded by fast-mode string marshalling), on this branch,
comparing `fast: true` — the whole **gc-native** lane — against `fast: false`:

| source                  | `fast: true` (gc-native)              | `fast: false` (host-call) |
| ----------------------- | ------------------------------------- | ------------------------- |
| `1 + 1` (control)       | ok                                    | ok                        |
| `(3).toString()`        | **RUNTIME TRAP** — null pointer deref | ok                        |
| `String(n)`             | **RUNTIME TRAP** — null pointer deref | ok                        |
| `n.toFixed(2)`          | **RUNTIME TRAP** — null pointer deref | ok                        |
| `n.toString(16)`        | **RUNTIME TRAP** — null pointer deref | ok                        |
| `JSON.stringify({a:42})`| **RUNTIME TRAP** — null pointer deref | ok                        |
| `[1,22,333].join(",")`  | **RUNTIME TRAP** — illegal cast       | ok                        |

Six of six number→string operations trap in the flagship no-host-calls lane
and all six pass through the host. The control passes in both, so this is not
a probe artifact. Every one of them **compiles and instantiates cleanly and
traps on the call** — i.e. exactly the `failedPhase: "warmup"` shape, the one
that is indistinguishable from "not applicable" when the row is dropped.

So the pre-fix harness was not hiding cosmetic gaps in a chart. It was capable
of hiding a **correctness hole in the primary lane the project promotes**, and
presenting it on the public page as a lane that simply does not apply. That is
the argument for this change, and it is measured rather than asserted.

Credit: the gating mismatch was root-caused during #3902; the numbers above
are an independent reproduction on this branch. The traps themselves are a
**separate defect and are NOT fixed here** — they have been escalated for their
own issue. This change only makes them capable of showing up as `FAILED`
instead of as an absent bar.

## Fix

Outcome **1** — the lane works; it was a two-character-class wiring bug, not a
fundamental incompatibility with the Node harness. No benchmark was removed.

- `benchmarks/suites/dom.ts` — one shared `domDeps` that adds
  **`document: mockDoc`** alongside the classes; the four dead `extraEnv`
  blocks deleted.
- `benchmarks/harness.ts` — a failed strategy is now recorded as a
  `status: "failed"` row carrying `error` (first line) and `failedPhase`
  (`setup` | `warmup` | `calibration` | `mid-loop`), with all timing fields
  zeroed, plus an exported `isMeasured()` guard. **A `skip`-listed strategy
  still produces no row at all**, so the two states are finally distinct:
  *absent = not applicable*, *`status: "failed"` = broken lane*. The stderr
  wording is unchanged so existing greps keep matching. `extraEnv` removed
  from `BenchmarkDef`.
- `benchmarks/report.ts` — `winner()` no longer lets a zero-median failed lane
  win; `speedup()` / binary-size / compile-time columns skip failed rows; the
  summary table prints `FAILED` (vs `—` for not-applicable); a new
  **`## Failed strategies`** table lists benchmark / strategy / phase / error;
  `buildHistory()` excludes failed rows so no phantom "infinitely fast" point
  lands in the trend series.
- `scripts/benchmark-lifecycle.mjs` — `validateInternalSuite` exempts
  `status: "failed"` rows from the `finitePositive(medianMs)` gate (they would
  otherwise fail artifact validation) but *requires* a non-empty `error`, and
  rejects a failed **`js`** row outright: the JS reference is the scale every
  other lane is measured against, so it may never fail. Now exported for test.
- `website/components/perf-benchmark-chart.js` — `benchmark-runtime` mode
  renders a failed lane as a named, zero-length bar labelled **`failed`**
  instead of dropping it, so a dead lane is visible on the page.

## Test Results

`tests/issue-3904.test.ts` — 11 tests, all pass. Covers: the four defs carry a
`document` dep and do not skip `host-call`; each of the four host-call lanes
compiles, instantiates and runs without trapping; `dom/read-attributes`
returns 1000 through the host boundary; a deliberately-broken def yields a
`status: "failed"` row (phase `warmup`, message intact) while its skipped lane
yields no row; failed lanes never win the markdown summary; failed lanes are
excluded from history; and the artifact validator accepts a failed row,
rejects one with no message, rejects a failed `js` row, and still requires a
positive median on normal rows.

`tests/benchmark-lifecycle.test.ts` — 20/20 still pass. `tsc --noEmit` clean.

### Verified against a real, independent failure

The failure-recording path was also confirmed on a lane neither authored nor
fixed here — `array/find`'s `linear-memory` lane, surfaced by #3902. It fails
at **instantiate** time, so it exercises the `setup` phase that the DOM bug
(which fails at first call, i.e. `warmup`) does not:

```
npx tsx benchmarks/run.ts --suite arrays --filter find
  array/find ...
    [linear-memory skipped: WebAssembly.instantiate(): Compiling function #50:"run" failed: local.set[0] expected type i32, found local.get of type f64 @+4412]
 js: 0.709ms  |  host-call: 1.370ms  |  linear-memory: FAILED
```

The resulting `latest.json` row, and the summary line it produces:

```json
{
  "name": "array/find", "strategy": "linear-memory",
  "iterations": 0, "batchSize": 0, "totalMs": 0, "avgMs": 0,
  "medianMs": 0, "p95Ms": 0,
  "status": "failed",
  "error": "WebAssembly.instantiate(): Compiling function #50:\"run\" failed: local.set[0] expected type i32, found local.get of type f64 @+4412",
  "failedPhase": "setup"
}
```

```
| array/find | 0.709ms | 1.37ms | — | FAILED | js |
```

That single row is the whole point of the change: `—` for the deliberately
skipped `gc-native`, `FAILED` for the broken `linear-memory`, and `js` as
winner rather than the zero-median failed lane. `validateInternalSuite`
accepts this real file unchanged. (Both observed failure shapes — trap-on-call
and fail-at-instantiate — are covered; the former is the one that reads most
like "not applicable" when the row is simply omitted, which is exactly how
this issue went unnoticed.)

**That `—` is worktree-specific and will change.** It reflects
`array/find`'s `skip: ["gc-native"]` as of this branch. #3902 *removes* that
skip, so once both land the same command yields four populated lanes with
`linear-memory` still `FAILED` — not a regression, and not a contradiction of
the row above. Re-derive the row rather than trusting this transcript if the
two disagree; a pasted output that silently stopped matching reality is the
same failure family as the bug this issue fixes.

The `array/find` linear-memory typing bug itself is a genuine linear-backend
defect and is **not** fixed here — it is now merely *visible* rather than
silently absent. It needs its own issue.

### Measured numbers (AC 4)

`npx tsx benchmarks/run.ts --suite dom --strategy js,host-call`, Node
v22.22.2, linux x64, 4-core container under concurrent agent load — treat as
indicative, not a publication-grade measurement (CI's `benchmark-refresh.yml`
produces the published figures):

| benchmark             | js (median) | host-call (median) | host-call vs js |
| --------------------- | ----------- | ------------------ | --------------- |
| `dom/create-elements` | 0.125 ms    | 1.083 ms           | 0.12x (8.7x slower) |
| `dom/set-attributes`  | 0.459 ms    | 1.065 ms           | 0.43x (2.3x slower) |
| `dom/read-attributes` | 0.179 ms    | 0.424 ms           | 0.42x (2.4x slower) |
| `dom/modify-text`     | 0.130 ms    | 1.180 ms           | 0.11x (9.1x slower) |

Slower than JS across the board, as expected for pure host interop — this is
the honest bar the issue asked for, not a win. The two element-*creating*
loops (`create-elements`, `modify-text`) are ~9x, the two attribute loops
~2.4x; that spread is consistent with per-crossing overhead dominating, and
lines up with the boundary-cost thesis in **#3903** — cross-reference there
before optimising. Per the non-goals, no optimisation was attempted here.

`benchmarks/results/latest.json` is **deliberately not regenerated in this
commit**: it is a whole-suite artifact and a `--suite dom` run would have
truncated it to four benchmarks. It is regenerated and committed on `main` by
`benchmark-refresh.yml`, which will pick up the working lane on the next
refresh.

## Follow-up observed (not fixed here)

`benchmarks/{dom,arrays,strings,mixed}.ts` are **byte-identical dead copies**
of `benchmarks/suites/*.ts`. Nothing imports them (`run.ts` imports only from
`suites/`) and no glob picks them up. `benchmarks/dom.ts` therefore still
carries the buggy pre-fix version. They were left alone to keep this diff
scoped, but they are a live trap: an editor can "fix" the wrong file and see
no effect. Worth a small cleanup issue.
