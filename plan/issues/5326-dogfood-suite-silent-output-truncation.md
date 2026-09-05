---
id: 5326
title: "Dogfood upstream suites report a truncated score when an upstream test stubs console"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: testing
goal: correctness
assignee: ttraenkler/claude
---

## Problem

`node --import tsx tests/dogfood/hono-upstream-suite.mjs` printed **four**
per-file lines, no headline, and exited **0**. Summing those four lines gives
`37/52` — exactly the figure that had been circulating as hono's score across
several agents. Nobody could see it was a fifth of the suite: hono prints
per-file lines, then the run simply stopped looking like it had more to say.

Measured on `upstream/main` @ `d1e53cbc9c`, stdout redirected to a file so pipe
buffering is not a factor:

```
[dogfood] hono@4.12.16 upstream v4.12.16 (90d4182aabd3)
[dogfood] src/http-exception.test.ts: 3/3 native; 2/3 Wasm
[dogfood] src/request.test.ts: 36/36 native; 32/36 Wasm
[dogfood] src/helper/accepts/accepts.test.ts: 8/8 native; 2/8 Wasm
[dogfood] src/helper/testing/index.test.ts: 5/5 native; 1/5 Wasm
                                            ^ 52 native, 37 Wasm — the "37/52"
```

## Root cause — the suite never truncated; its *stdout* did

The loop ran all twenty files every time. Proof: the generated `.native.mjs`
artefacts carry sequential mtimes spanning the whole run (07:46:14 → 07:48:17
for a 07:46–07:48 run), and `tests/dogfood/report/hono-upstream-suite.json` was
written with `compile.details.length === 20` and a complete summary. Only the
terminal went dark.

The native oracle lane executes upstream test bodies **in the harness process**
(`runNative` → `await import(nativePath)`), so any global a test replaces stays
replaced. hono's `src/helper/dev/index.test.ts` — selected file **5** — does
exactly that:

```ts
describe('showRoutes()', () => {
  let logs: string[] = []
  let originalLog: typeof console.log
  beforeAll(() => { originalLog = console.log; console.log = (...args) => logs.push(...args) })
  afterAll(() => { console.log = originalLog })
  ...
})
```

The shim in `UPSTREAM_TEST_EXPORTS` runs a test's `afterAll` hooks **only when
that test is the module's last registered test**, and each test captures only
the `afterAll` hooks in scope at its own registration (`describe()` truncates
`__upstreamAfterAll` back when its body returns). hono's last test lives in a
third `describe` (`getRouterName()`), so the `showRoutes` restores were never
reachable. `console.log` stayed pointed at a dead array — and the drivers built
their logger as `(...v) => console.log(...v)`, re-reading the mutable global on
every call. Every later `[dogfood]` line, including the headline and the report
path, went into `logs`.

Two consequences worth naming:

- The `--json` path was unaffected (it uses `process.stdout.write`), so the JSON
  report and terminal output disagreed silently.
- `scripts/generate-npm-compat-report.mjs` imports every driver's `runHarness`
  and runs them **in one process**. Once hono ran, every subsequent
  `[npm-compat] …` progress line in that generation was swallowed too.

The earlier lead that "the native lane stalls on test #2 of file 5" was a
misread of the same symptom; file 5 runs 8/8 native.

## Why exit 0 was the deeper defect

Even though this instance was an output bug, the shape it imitated is real: the
in-process native lane has **no deadline**. A test body awaiting a promise
nothing settles parks the driver's `await`; with nothing else pending the event
loop drains and Node exits **0** with a partial measurement and no error. The
harness had no invariant making "exit 0" mean "the harness reached its summary".
That is fixed independently of the console bug.

## Fix

`tests/dogfood/upstream-suite-runner.mjs` (shared by 18 drivers):

1. **`withHostConsole(body)`** — snapshot/restore `console` around all guest
   execution in `runNative`, reporting on stderr which methods were left
   stubbed. Containment lives here, not in the shim, because the hazard is
   structural: upstream tests are guests in the harness process and any of them
   may stub a global. Same policy as the existing
   `installNativeLateErrorBoundary` — record and keep going.
2. **`createHarnessLogger({quiet})`** — resolves `process.stdout.write` once at
   import time, so harness output cannot be intercepted by the code it measures.
3. **`runUpstreamFile(file, body, {timeoutMs})`** — per-file watchdog +
   try/catch. The timer is deliberately **not** `unref`'d: a ref'd timer keeps
   the loop alive while a file is in flight, converting a wedge from a silent
   exit-0 into a recorded timeout. A file that hangs, throws, or returns a
   degenerate result is scored as unmeasured and the loop continues.
4. **`summarizeUpstreamRuns`** now counts `filesWithoutResult` (+ per-file
   reasons) and surfaces `selectedFilesRun` / `filesWithoutResult` in
   `report.summary`; `unmeasuredFilesLine(report)` renders the
   `N of M selected files produced …` line drivers print after the headline.
5. **`cliUpstreamHarness`** sets `process.exitCode = 3` up front and clears it
   only when `runHarness` resolves. Exit 0 now means the harness reached its
   summary. `runDogfoodScript` rejects on non-zero exit, so a truncated run now
   fails the opt-in vitest tests instead of returning partial JSON.

`tests/dogfood/hono-upstream-suite.mjs` — logger from `createHarnessLogger`,
per-file body wrapped in `runUpstreamFile` (600 s, bounding the in-process
native lane; the compile worker keeps its own 240 s deadline), prints
`unmeasuredFilesLine`.

`tests/dogfood/uuid-upstream-suite.mjs` — has its own native lane, so it wraps
it in the now-exported `withHostConsole`; **prints its headline**, which
previously existed only inside the JSON; records a file whose native lane throws
instead of aborting the loop; same exit-code invariant.

## Evidence

Before/after on the same base (`upstream/main` @ `d1e53cbc9c`), same command.
Before: 5 lines, no headline, exit 0. After: 20 files, headline, completeness
line, exit 0.

```
[dogfood] restored host console.log left stubbed by upstream test code   (stderr, after file 4)
[dogfood] src/helper/dev/index.test.ts: 8/8 native; 0/8 Wasm
… 15 more files …
[dogfood] 244/324 admitted original tests pass in Wasm; 100 upstream files explicitly deferred
[dogfood] 20 of 20 selected files produced a result
```

**hono's real score: 244/324 (75.3 %)** admitted original tests passing in Wasm
across all 20 selected files — not `37/52`. 324 registered, 324 native-admitted,
0 runtime-failed, 20/20 compiled, 19/20 validated.

Per-file Wasm: http-exception 2/3, request 32/36, accepts 2/8, testing 1/5,
dev 0/8, powered-by 3/3, trailing-slash 36/36, accept 28/28, basic-auth 3/6,
body 27/37, cookie 24/35, encode 40/44, concurrent 0/6, buffer 4/10, crypto 1/4,
filepath 2/2, html 0/1, ipaddr 4/16, mime 3/3, url 32/33.

The 16 files that were invisible carry 207 of the 244 passes. `body.test.ts`
(file 10) shows the 27/37 that PR #5589 delivered — a gain that was completely
unobservable in a full-suite run.

**uuid was complete, not truncated** — 10/10 pinned files ran; it simply never
printed its headline. Now prints `75/75 admitted upstream tests passed in Wasm`
and `10 of 10 selected files produced a result`.

`clsx` (an unmodified driver) runs clean under the shared changes: `29/32`,
exit 0.

### Tests

`tests/dogfood/upstream-suite-runner.test.ts` — 16 → 23 tests, all passing. The
load-bearing one, `restores a console the guest module stubbed and never put
back`, drives `compileAndRunUpstreamModule` with a module shaped like hono's
(the stubbing `describe` is not the one holding the last test) and asserts
`console.log` is unchanged afterwards. A/B: with `withHostConsole` reduced to a
pass-through it fails with `expected [Function anonymous] to be [Function log]`.
The rest cover the watchdog, the throwing-file path, the zero-registration case,
and the `filesWithoutResult` accounting.

Both opt-in heavy tests pass and now assert completeness:
`DOGFOOD_HONO_UPSTREAM_SUITE=1` (20 files, `filesWithoutResult: 0`, ≥244/324)
and `DOGFOOD_UUID_UPSTREAM_SUITE=1` (10 files, 75/75).

### Two stale opt-in assertions fixed along the way

Neither `DOGFOOD_HONO_UPSTREAM_SUITE` nor `DOGFOOD_UUID_UPSTREAM_SUITE` is set
anywhere in `.github/`, so these tests **never run in CI** — the same
no-reader defect as the headline itself:

- hono's heavy test asserted `passed: 90, runtimeFailed: 6, validated: 18`
  against an actual 244/324, 0, 19. Structure stays pinned exactly; the Wasm
  pass count is now a **floor** (≥244, measured 2026-09-05), because an exact
  pin on a never-run test is precisely how it rotted.
- uuid's heavy test asserted `file.compiled` / `file.validated`; the driver has
  only ever emitted `success` / `validates`, so both read `undefined` and the
  test had been failing since it was written. Corrected to the real keys.

## Residual — named, not fixed

- **`react`, `react-dom`, `eslint`, `lit`** each have their own in-process
  native lane and do **not** route through `compileAndRunUpstreamModule`, so
  they are structurally exposed to the same hazard. Their pinned checkouts are
  not present locally, so whether any of their selected tests actually stub
  `console` is **unmeasured** — this is not a claim that they are clean. The fix
  is one line each: wrap the in-process execution in the now-exported
  `withHostConsole`.
- Only hono and uuid print the completeness line. The other 16 drivers get the
  `filesWithoutResult` fields in their JSON and the exit-code invariant, but
  still print only a headline; adding `unmeasuredFilesLine(report)` to each is
  mechanical.
- The watchdog cannot reclaim a wedged in-process microtask — it bounds the
  wait, not the work. Moving the native lane into a child process (as the
  compile lane already is) would.
- The opt-in heavy dogfood tests run in no CI lane at all. Until one runs them,
  their assertions will keep rotting; that is a scheduling decision, not a
  harness change.
