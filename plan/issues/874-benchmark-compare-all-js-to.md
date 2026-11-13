---
id: 874
title: "Benchmark: compare all JS-to-Wasm engines on standard performance benchmarks"
status: in-progress
created: 2026-03-30
updated: 2026-10-10
priority: medium
goal: spec-completeness
sprint: current
---
# Benchmark: compare all JS-to-Wasm engines on standard performance benchmarks

## Problem

Our comparison table in the blog post has "No benchmarks yet" for js2wasm and "No data" for several competitors. We cite third-party claims (Porffor: "10-30x faster than interpreter-bundling", QuickJS: "20-100x slower than V8") but have not independently verified any of them. We need our own numbers.

## Engines to benchmark

**AOT compilers (no bundled runtime):**
- js2wasm (our project)
- Porffor
- JAWSM (if it can run the benchmarks)

**Interpreter-bundling:**
- Javy (QuickJS in Wasm)
- StarlingMonkey (SpiderMonkey in Wasm, if extractable)

**Baselines:**
- V8 / Node.js (1x reference)
- QuickJS standalone (interpreter baseline)

## Benchmark suites

### Primary: Octane subtests (cherry-picked, DOM-free)

- **Richards** — OOP scheduler, vtable/dispatch overhead
- **DeltaBlue** — constraint solver, object allocation + method calls
- **RayTrace** — floating point math, object creation, numeric codegen
- **NavierStokes** — 2D array manipulation, tight loops, array access
- **Box2D** — physics simulation, complex object graphs + math

These are pure JS, run in Node.js, no DOM. V8 is heavily optimized for them — that's a feature: it gives us a best-case ceiling.

### Secondary: Kraken subtests

- **audio-fft, audio-oscillator** — DSP patterns
- **crypto-aes, crypto-sha256** — bitwise operations, tight loops
- **imaging-gaussian-blur** — 2D array traversal

Complements Octane with real-world compute patterns (crypto, DSP, image processing).

## Dimensions to measure

For each engine x benchmark:

1. **Startup time** — time to first output (AOT should beat interpreter-bundling)
2. **Peak throughput** — sustained compute (ops/sec or wall-clock time)
3. **Binary size** — total module size (matters for edge/serverless)
4. **Memory footprint** — peak RSS during execution

## What to avoid

- Speedometer (needs DOM)
- SunSpider (too small, startup-dominated)
- Benchmarks requiring `eval()` or dynamic code generation (Wasm can't do this)
- Any benchmark that uses features js2wasm doesn't support yet (start with what we can compile)

## Acceptance criteria

- [ ] Harness that runs selected Octane + Kraken subtests across all available engines
- [ ] Results table with startup, throughput, binary size, memory for each engine x benchmark
- [ ] Results published to `benchmarks/results/` alongside existing test262 reports
- [ ] Blog comparison table updated with real numbers replacing "No data" / "No benchmarks yet"

## Notes

- Start with the Octane subtests we can actually compile today. Even partial results (2-3 subtests) are more valuable than no data.
- Some benchmarks may need minor modifications to avoid unsupported features (eval, with, etc.)
- Porffor and JAWSM may not compile all subtests — document what works and what doesn't.
- This is also a good stress test for js2wasm's conformance: if a benchmark fails to compile, that's a data point too.

## Implementation Plan — Octane harness slice (2026-10-10)

Slice `874:octane-harness`, claimed by `ttraenkler/claude-session-c-octane-20261010`
(note: `claim-issue.mjs --check 874` reads only the base id and reports
`UNASSIGNED`; the slice claim is by convention, not on the lock ref). Planner:
Claude Fable 5.1. This slice delivers the **harness** and an **honest status
table**; it does not fix the compiler and it wires **no CI**.

### Why now

NightMonkey (Fallin, VMIL 2026) published Octane numbers we want comparable
numbers to: Richards AOT ~16.4k vs native JIT ~28k, and "Porffor passes only
richards (1470)". Octane scores are `reference / mean-µs-per-run × 100`, so a
harness that keeps Octane's own reference constants and validation makes our
Richards score directly comparable to theirs. See `.tmp/nightmonkey-notes.md`
(scratch, not committed) for the source list.

### Probe findings (actually run, 2026-10-10, this container)

Machine: 4 vCPU Intel Xeon @ 2.80 GHz, 16 GB, node v22.22.0, uptime 5 min at
probe time (fresh instance — absolute ms below are **not** comparable to any
other session; only the per-row status and same-run ratios are). Probe scripts:
`.tmp/octane-probe{,2,3,4}.mjs` (gitignored).

**Network.** `raw.githubusercontent.com/chromium/octane/<sha>/<file>` → 200
through the agent proxy. `api.github.com` and `codeload.github.com` → 403 (the
proxy only passes raw + anonymous git). A shallow clone of the repo works
(cloned to `/home/user/chromium/octane`, outside the repo). So the fetch script
must use raw URLs pinned to a commit, never the API.

**Octane pin.** `chromium/octane` HEAD = `570ad1ccfe86e3eecba0636c8f932ac08edec517`
(2017-04-12, "Update files for Octane retirement (#46)"). The project is
retired, so this is final; `BenchmarkSuite.version = '9'`. SHA256 of the files
this slice uses:

| file | sha256 | license (header) |
| --- | --- | --- |
| `LICENSE` | `cf853177951c6de1b17c029b66edf71f8b194cca1722339a7b5def4e8165aaaa` | BSD-3 (V8 authors) |
| `base.js` | `216612c2e7096a02b3e52b57e9cf9351bbaf180d60938d5c60b85fd756232733` | BSD-3 |
| `richards.js` | `1246a64a24b931158bf01c24640343259fa74b0226e73bad630bd1f686aa0fa7` | BSD-3 |
| `deltablue.js` | `6c4784e82f3e8f5c18306d289653d08b17b38838f1bac16b38611d7318fa5a36` | **GPL-2+** (Maloney/Wolczko) |
| `crypto.js` | `b01b6b3fe534327fdef05131162927bc5508f100a3208e185d0c5a4efb200a39` | MIT-style (Tom Wu) |
| `raytrace.js` | `64b8ff90969966dd69659100e28754976dfc3e9a4f8ee55b9232f974c66ed08c` | MIT-style (Prototype) + BSD-3 |
| `navier-stokes.js` | `27926de809451c60b0c49a4185c08f97081310d0db166a30c1d202fb656556a2` | MIT (Oliver Hunt) + BSD-3 |
| `splay.js` | `f9a6a60d8f205908f5542ad1180abc1902dcdab3dcb4278017c5ce179ee123f7` | BSD-3 |
| `regexp.js` | `a292d6047900c5296ea9e2628453832cc3bfe397e49fddade8aff7b5876c8263` | BSD-3 |
| `earley-boyer.js` | `8dd28a505f7e705642f86816232b012fd3c770ec8afc9f719ce89ce772dab347` | BSD-3 (Bigloo output; header is a redirection note) |
| `box2d.js` | `83b10c280f004e7b156a9e04d09ce4109892ea92788f7c6c963f7fadf29c7bd4` | zlib (Erin Catto) + Google |

**Licenses verdict: do NOT vendor.** The files are mixed BSD-3 / MIT / zlib /
**GPL-2** (deltablue; also pdfjs and gbemu, which we skip anyway). The repo's
one third-party convention is a pinned, `update = none` submodule
(`vendor/Porffor`, `test262`); a submodule would also work but pulls 10.5 MB
including the 5 MB `mandreel.js` we exclude and still needs a manual
`submodule update --init`. Decision: a **fetch script pinned to commit +
per-file SHA256** into gitignored `.octane-cache/<sha>/`, same shape as
`scripts/fetch-baseline-jsonl.mjs` → `.test262-cache/`. Nothing from Octane is
committed; the GPL file is only ever downloaded and executed locally, never
redistributed. The committed `manifest.json` records the license per file so
nobody re-decides this by accident.

**Benchmark selection.** DOM-free and plausible: `richards`, `deltablue`,
`crypto`, `raytrace`, `navier-stokes`, `splay`, `regexp`, `earley-boyer`,
`box2d` (9). Excluded with reason (recorded in `manifest.json` under
`excluded`, so the report can print them as `skipped`): `zlib` (`var zlibEval =
eval`, and `read()` is a d8 builtin), `code-load` (eval / `new Function` is the
benchmark), `typescript` (eval; 2.5 MB input), `pdfjs` (GPL, 1.4 MB, `new
Function`, canvas stubs), `mandreel` (5 MB, eval), `gbemu` (GPL, 500 KB,
canvas/`window` stubs). `splay`'s latency sub-score (`SplayRMS`, uses
`performance.now`) is not measured — only its throughput score.

**js2 compile/run status with a `PRELUDE + base.js + <bench>.js + exports`
driver** (`compile(src, { fileName: "octane.js", allowJs: true,
skipSemanticDiagnostics: true, validate: false[, target: "standalone"] })`;
`PRELUDE` = `var alert; var performance = { now: … }; var print = …;` because
`base.js` assigns `alert = …` as a sloppy implicit global and reads
`performance` before declaring it):

| bench | gc host: compile | gc host: run | standalone: compile | standalone: run | node (vm, same proc) |
| --- | --- | --- | --- | --- | --- |
| richards | ok 3.0 s, 120 KB | **trap** `Cannot access property on null` at `Packet.prototype.addTo` → `next.link = this` | ok 2.7 s, 359 KB | **trap** null deref | 4.4 ms/run |
| deltablue | ok 3.6 s, 139 KB | `addConstraint is not a function` (`Object.defineProperty(Object.prototype, "inheritsFrom", …)` dynamic prototype extension) | ok 3.4 s, 417 KB | Wasm exception (opaque) | n/a — see note (a) |
| crypto | ok 3.7 s, 314 KB | `setupEngine is not defined` (sloppy implicit global `setupEngine = function…`) | ok 6.2 s, 806 KB | Wasm exception | 12.1 ms |
| raytrace | ok 2.3 s, 146 KB | Wasm exception | **compile-error**: `__get_builtin` not supported in standalone (#1472 Phase B) + driver implicit-any | — | 15.6 ms |
| navier-stokes | ok 1.2 s, 111 KB | null at `checkResult` → `this.result` (sloppy `this` = global in a plain call) | ok 1.9 s, 447 KB | Wasm exception | 7.5 ms |
| splay | ok 1.0 s, 95 KB | `Key not found: 0.935…` (object used as map with numeric-string keys) | ok 1.6 s, 299 KB | Wasm exception | 97 ms |
| regexp | ok 5.7 s, 226 KB | null at 528:24 | ok 52 s, 1.1 MB | Wasm exception | 50 ms |
| earley-boyer | 15.7 s, 520 KB → **invalid wasm** (`sc_jsNew`: `local.tee` expected `ref null`, found `i32`) | — | 33 s, 4.2 MB → **invalid wasm** (same function) | — | 286 ms |
| box2d | **78 s**, 1.65 MB → **invalid wasm** (`__closure_879`: `extern.convert_any` expected `anyref`, found `i32`) | — | **242 s**, 10.9 MB | Wasm exception | n/a — see note (b) |

Bottom line for the slice: **every selected benchmark compiles on the gc host
lane, 8/9 on standalone, and none runs to completion on either lane today.**
That is the data point the issue asked for ("if a benchmark fails to compile,
that's a data point too") — the harness must publish exactly this table, not an
empty one. Notes:

- (a) The node reference ran in a `vm` context inside the same process as the
  js2 gc lane; deltablue's js2 run had already defined
  `Object.prototype.inheritsFrom` on the shared realm via host imports, so the
  node run failed with `Cannot redefine property`. **Every (bench, lane) must
  run in its own child process.** (b) box2d reads the global object (`Box2D` is
  attached to `this`); the node worker must run the driver as a real script in
  a fresh `node` process, not a stripped `vm` context.
- The richards trap is **not** the `while ((peek = next.link) != null)`
  idiom: a 20-line repro of that passes on both lanes (`.tmp/octane-probe3.mjs`),
  and rewriting `addTo` to a plain `while` or adding `if (next == null) throw`
  one line before the store still traps **at the store** (`.tmp/octane-probe4.mjs`).
  So `next` reads as non-null for `==` but the `next.link = this` field store
  sees null — likely a representation mismatch between the generic `queue`
  parameter and the `Packet`-typed local. Hand this to a codegen issue
  (allocate the id with `claim-issue.mjs --allocate`); it is the single blocker
  between "richards compiles" and a Richards score.
- Standalone failures surface as `[object WebAssembly.Exception]` with no
  message. The worker must decode the payload via the module's exported
  exception tag when present, and otherwise report `runtime-error (opaque wasm
  exception)` — never swallow it.
- Compile times matter: box2d takes 78 s (gc) / 242 s (standalone). The
  harness needs a per-(bench, lane) **compile timeout** (default 300 s, flag)
  and `--only`.

### File layout

```
benchmarks/octane/
  README.md          what/why, how to run, how to read, the uptime caveat (point at the
                     cross-engine README's restart-trap paragraph)
  manifest.json      octane commit, per-file {sha256, license}, selected benches
                     {files, suiteName, reference, validationMessages, hasValidation,
                     minReps, preludeVars}, excluded {name, reason}
  fetch.mjs          download pinned files → .octane-cache/<commit>/, verify sha256,
                     idempotent, --force; exits non-zero on hash mismatch (deletes the bad file)
  driver.mjs         buildDriver(bench, manifest, files) → the ONE source string
                     every lane consumes (exported for the workers and for tests)
  run.mjs            CLI orchestrator: --only a,b --lanes node,gc,standalone,linear,porffor
                     --reps N --timeout S --out path; spawns one worker per (bench, lane)
  worker-node.mjs    child: writes driver to .tmp/octane/<bench>.js, runs it as a plain
                     script in a fresh node process, prints one JSON line
  worker-js2.mjs     child: compile (lane → CompileOptions), instantiate, time, print JSON
  worker-porffor.mjs child: `porf <driver>` with PORFFOR_DIR, parse the result line
.gitignore           + `.octane-cache/`
package.json         "benchmark:octane": "node --import tsx benchmarks/octane/run.mjs",
                     "benchmark:octane:fetch": "node benchmarks/octane/fetch.mjs"
benchmarks/results/octane-latest.json, octane-<YYYYMMDD-HHMMSS>.json
                     (both already gitignored by `benchmarks/results/*.json`;
                     committing a snapshot is a later slice's decision)
```

No `src/` changes. `check-loc-budget` / `check-func-budget` do not cover
`benchmarks/`, but run the full gate chain before committing anyway (CLAUDE.md).

### Driver contract (same source on every engine)

`buildDriver()` concatenates, in order:

1. `PRELUDE` — `var alert; var print = function () {}; var performance = { now: function () { return 0; } };`
   plus `var setupEngine;` for crypto (declared-global shim; the engine must
   still *assign* it — this only removes the sloppy implicit-global dependency
   that no strict compiler accepts). Shims are listed per bench in the manifest
   (`preludeVars`) so the report can show them; **no benchmark body is edited**.
2. `base.js` verbatim (its `alert = function(s){ throw … }` override is what
   turns deltablue's `alert("Chain test failed.")` into a thrown error — keep it).
3. The bench file(s) verbatim.
4. Epilogue (the only js2-specific syntax is `export`; the node and Porffor
   workers strip `export ` and append `globalThis.__octane_run = octane_run`):

```js
/** @param {number} reps */
export function octane_run(reps) {
  BenchmarkSuite.ResetRNG();               // Octane's deterministic Math.random
  var count = 0;
  for (var s = 0; s < BenchmarkSuite.suites.length; s++) {
    var suite = BenchmarkSuite.suites[s];
    for (var b = 0; b < suite.benchmarks.length; b++) {
      var bench = suite.benchmarks[b];
      bench.Setup();
      for (var r = 0; r < reps; r++) { bench.run(); count++; }
      bench.TearDown();
    }
  }
  return count;
}
```

The JSDoc `@param` is required: raytrace's standalone compile failed on the
implicit-any of a bare `reps`. Walking `BenchmarkSuite.suites` (not calling
`runRichards()` by name) means the same epilogue serves all nine benches and
multi-benchmark suites (crypto = Encrypt+Decrypt, earley-boyer = Earley+Boyer)
run both parts, as Octane does.

**Validation** uses Octane's own checks, which all throw out of `run()` (or call
`alert`, which base.js makes throw): richards `EXPECTED_QUEUE_COUNT/HOLD_COUNT`,
deltablue `Chain/Projection N failed`, raytrace `Scene rendered incorrectly`,
navier-stokes `checksum failed` (fires at frame 15 — so `reps ≥ 15` for that
bench, enforced by `minReps` in the manifest), splay `wrong size/not sorted`,
crypto `Crypto operation failed`, regexp `Wrong checksum.`, earley-boyer
`incorrect number of rewrites`. **box2d has no validation in Octane**; it is
reported as `pass-unvalidated`, never as `pass`. A wrong answer therefore
cannot score: the worker classifies a throw whose message matches the bench's
`validationMessages` as `wrong-result`, every other throw as `runtime-error`.

**Per-row status enum** (exactly one per (bench, lane), always emitted):
`skipped` (with `reason`: excluded bench, lane unavailable, timeout) ·
`compile-error` · `invalid-wasm` (compiled but `WebAssembly.compile/instantiate`
rejects — earley-boyer, box2d today) · `instantiate-error` (missing import etc.) ·
`runtime-error` · `wrong-result` · `pass-unvalidated` · `pass`. Only `pass` and
`pass-unvalidated` carry timings; a `pass-unvalidated` row is flagged in the
printed table. **A benchmark that does not compile is a row, never an omission**
— same rule as `harness.ts`'s `status: "failed"` rows (#3904).

### Lanes

| lane | how | availability |
| --- | --- | --- |
| `node` | `node .tmp/octane/<bench>.js` (plain script, fresh process) — the 1× reference | always |
| `gc` | `compile(src, {fileName:"octane.js", allowJs, skipSemanticDiagnostics, validate:false})`, `buildImports` + `instantiateWasm` as `benchmarks/cross-engine/run-js2.mjs` / `harness.ts` do | always |
| `standalone` | same with `target: "standalone"`; assert zero imports (a leaked import → `instantiate-error`, as zlib showed with `js2wasm:runtime-eval`) | always |
| `linear` | `target: "linear"` + `buildImports` as `harness.ts` `linear-memory` does | always attempted; expect `compile-error` rows — report them |
| `porffor` | `$PORFFOR_DIR/porf driver.js`, default `/home/user/porffor` (cross-engine convention) | **not installed here** (`/home/user/porffor` absent; `vendor/Porffor` submodule uninitialised) → `skipped: porffor not installed` on every row |

One child process per (bench, lane) — isolation from realm pollution (note a),
OOM, and hangs; `run.mjs` kills a worker at `--timeout` and records
`skipped: timeout`. Workers print a single JSON line; the orchestrator never
parses free text (Porffor's stdout carries C-compiler warnings — filter as
`run-node-porffor.mjs` does).

### Scoring

Per passing row the worker records `warmupRuns`, `reps`, `samples` (N=5 timed
calls of `octane_run(reps)`), `meanUsPerRun`, `minUsPerRun`. Choice of `reps`:
calibrated **once on node** so one `octane_run(reps)` call takes ≥ 50 ms, then
the **same `reps` is passed to every lane** (identical work is what makes
navier-stokes' frame-15 check and all ratios meaningful); `--reps` overrides.

- `octaneScore = manifest.reference[0] / meanUsPerRun × 100` — Octane's exact
  formula (`BenchmarkSuite.prototype.NotifyResult` + `FormatScore`), computed
  from the **mean** because that is what Octane and NightMonkey report; this is
  the number to put next to NightMonkey's 16.4k / Porffor's 1470 for Richards.
  Deviations from Octane proper are recorded in the JSON `methodology` field:
  fixed reps instead of "≥ 1 s", N=5 instead of one window, latency sub-scores
  not measured, `version: '9'` reference constants.
- `ratioVsNode = node.minUsPerRun / lane.minUsPerRun` — the min-of-N
  cross-engine ratio this repo already reports (`benchmarks/cross-engine`); the
  table prints the mean-based score and the min-based ratio side by side so
  nobody has to re-run to get either.
- Geomean of Octane scores is printed **only over benches that pass on every
  compared lane**, with the bench list beside it; a geomean over different
  subsets is not a comparison.

### Output JSON (`benchmarks/results/octane-latest.json`)

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "...", "js2Commit": "<HEAD sha>", "octaneCommit": "570ad1cc…",
  "machine": { "cpu": "<os.cpus()[0].model>", "cores": 4, "memMB": 16093,
               "node": "v22.22.0", "platform": "linux-x64",
               "uptimeSec": 300,
               "caveat": "absolute µs are machine- and instance-specific; low uptime = fresh instance, see benchmarks/cross-engine/README.md restart trap; compare ratios within one run only" },
  "lanes": { "node": {...}, "gc": {"js2": "<version>"}, "standalone": {...}, "linear": {...},
             "porffor": { "available": false, "reason": "..." } },
  "methodology": { "reps": "node-calibrated ≥50ms", "samples": 5, "score": "reference/meanUs*100 (Octane v9)", ... },
  "rows": [ { "bench": "richards", "lane": "gc", "status": "runtime-error",
              "error": "TypeError: Cannot access property on null or undefined at 925:3",
              "compileMs": 3012, "binaryBytes": 119597, "reps": null, "meanUsPerRun": null, ... } ],
  "excluded": [ { "bench": "zlib", "reason": "eval" }, ... ]
}
```

Every (selected bench × lane) pair appears in `rows`. The printed table has one
line per bench with one cell per lane: `score (ratio)` or the status word.

### Implementation order

1. `manifest.json` + `fetch.mjs` + `.gitignore` entry; `node benchmarks/octane/fetch.mjs`
   must verify all 11 hashes above (and refuse a mismatch).
2. `driver.mjs` + `worker-node.mjs`; `node` lane passes all 9 (box2d
   `pass-unvalidated`) — this proves the driver, not js2.
3. `worker-js2.mjs` (gc, standalone, linear) with the status classifier and the
   exception-tag decoder; reproduce the probe table above.
4. `worker-porffor.mjs` (skipped path exercised here; real path only if
   `PORFFOR_DIR` exists).
5. `run.mjs` orchestration, JSON writer, table printer, `package.json` scripts,
   README.
6. File the richards-trap codegen issue (allocate id) with the
   `.tmp/octane-probe4.mjs` finding and link it from `plan/log/dependency-graph.md`
   as the blocker for the first js2 Octane score; link this issue's slice.

### Acceptance criteria (this slice)

- [ ] `pnpm run benchmark:octane:fetch` fetches the pinned files into
      `.octane-cache/570ad1cc…/`, verifies SHA256, and is a no-op on re-run.
- [ ] `pnpm run benchmark:octane` runs end to end on this container and writes
      `benchmarks/results/octane-latest.json` + a timestamped twin.
- [ ] Every selected bench × lane (9 × 5 = 45 rows) has exactly one status;
      excluded benches appear under `excluded` with a reason; the Porffor lane
      is `skipped` with the reason when not installed.
- [ ] `richards` is measured on `node` (score + µs). On js2 it is reported with
      its real status — today `runtime-error` on both lanes; if the codegen
      issue lands first it must show a score **and** the validation must have
      run (a tampered `EXPECTED_QUEUE_COUNT` must flip it to `wrong-result`).
- [ ] A wrong answer cannot score: `pass` requires a validated run; box2d is
      `pass-unvalidated`.
- [ ] Each (bench, lane) runs in its own child process with a timeout; the
      node reference is a plain-script process.
- [ ] No Octane source is committed; `manifest.json` carries per-file license.
- [ ] No CI wiring: no workflow, no gate, no baseline file — explicitly out of
      scope for this slice (a later slice may promote `octane-latest.json`).
- [ ] Gate chain green before commit (`check-loc-budget`, `check-func-budget`,
      `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).

### Out of scope / follow-ups

Kraken subtests; startup / binary-size / RSS dimensions (the JSON schema has
room: `binaryBytes` now, the rest later); fixing any of the nine js2
failures (each is its own codegen issue — richards first); Javy/StarlingMonkey/
JAWSM lanes; publishing to the website; CI.

## Octane harness slice — implementation notes (2026-10-10)

Implemented per the plan above in `benchmarks/octane/` (`manifest.json`,
`fetch.mjs`, `driver.mjs`, `common.mjs`, `run.mjs`, `worker-{node,js2,porffor}.mjs`,
`README.md`), `.gitignore` (`.octane-cache/`) and `package.json`
(`benchmark:octane`, `benchmark:octane:fetch`). No `src/` change, no CI.
`fetch.mjs` verified all 11 pinned hashes on this container. Deviations from
the plan, and why:

- **Setup once / TearDown once, not per call.** The plan's epilogue wrapped
  every `octane_run(reps)` in Setup…TearDown. box2d's TearDown sets
  `Box2D = null`, so the second call (calibration, warm-up, samples) died with
  "Cannot read properties of null (reading 'Common')" even on node. Octane's own
  RunStep does ResetRNG → Setup → many runs → TearDown, so the epilogue now
  sets up lazily inside the first call and exports `octane_teardown()`, which
  every worker calls after the samples (a throw there is a `runtime-error`,
  phase `teardown`).
- **Calibration discards the first call and takes min-of-2.** Without that,
  splay / regexp / earley-boyer / box2d calibrated to `reps = 1` because the
  first call carried Setup and JIT tier-up.
- **Crypto shim list extended** to every sloppy implicit global in crypto.js
  (`nValue … coeffValue`, alongside the planned `setupEngine`). With only
  `setupEngine` declared, both js2 lanes stopped at `ReferenceError: nValue is
  not defined` — same class, same rule, listed in `manifest.json` `preludeVars`.
- **Two timeouts.** `--timeout` (compile + instantiate, default 900 s) and
  `--run-timeout` (default 180 s, armed when the worker prints its READY line).
  crypto/gc now gets past init and does not finish 22 reps (node: ~38 ms) in
  180 s; a single budget would have spent 900 s per such row.
- **Init-phase Wasm exceptions are reported as opaque, with the reason.** A
  throw from the module's start function leaves no instance, so `__exn_tag`
  is unreachable; the row says so instead of `[object WebAssembly.Exception]`.
- **Tamper self-test** (`--tamper`, manifest `tamper` snippet, richards only):
  node reports `wrong-result` ("Error during execution: queueCount = 2322…"), so
  a wrong answer cannot score.
- The plan's step 6 (allocate an id for the richards codegen issue) is left to
  the coordinator; candidates are listed below.

Results table (all 45 rows + 6 excluded): `benchmarks/octane/README.md`
§ "Latest committed results". Raw JSON stays gitignored
(`benchmarks/results/octane-latest.json`).

## Findings — js2 failures (run 2026-10-10T07:28Z, compiler 837fdb3105)

Every row reproduces with
`pnpm run benchmark:octane -- --only <bench> --lanes <lane>`; the exact driver
is written to `.tmp/octane/<bench>.module.js` and the binary to
`.tmp/octane/<bench>.<lane>.wasm`. **Driver line L = bench-file line L − 392**
(1 prelude line + 390 lines of base.js + separator).

| bench | lane | status | error (driver line:col → bench line) |
| --- | --- | --- | --- |
| richards | gc | runtime-error | `TypeError: Cannot access property on null or undefined at 925:3` → richards.js:533 `next.link = this` in `Packet.prototype.addTo` |
| richards | standalone | runtime-error | `RuntimeError: dereferencing a null pointer` in `__fnctor_TaskControlBlock_new` |
| deltablue | gc | runtime-error | `TypeError: addConstraint is not a function` (method added through `Object.defineProperty(Object.prototype, "inheritsFrom", …)` prototype rewiring) |
| deltablue | standalone | runtime-error | `TypeError: called value is not a function` |
| crypto | gc | skipped (run timeout) | compiles (5.8 s, 317 KB), instantiates, then does not finish 22 reps in 180 s (node: ~38 ms) — hang or ≥ 4000× slowdown |
| crypto | standalone | runtime-error | `RuntimeError: dereferencing a null pointer` in `rng_get_byte` (crypto.js:1430, `if (rng_state == null) { … rng_state = prng_newstate(); rng_state.init(…)`) |
| raytrace | gc | runtime-error (init) | opaque Wasm exception from top-level code (Prototype-style `Class.create` / `Object.extend` for-in copy run at load time — suspected, not bisected) |
| raytrace | standalone | compile-error | `'__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 Phase B)` |
| navier-stokes | gc | runtime-error | `Cannot access property on null or undefined at 538:39` → navier-stokes.js:146 col 39 = `x[1]` read in `set_bnd` (writes to `x` on the lines above succeed) |
| navier-stokes | standalone | runtime-error | `TypeError: uiCallback is not a function` (navier-stokes.js:322/350/369 — closure-captured `var uiCallback` reassigned by `setUICallback`) |
| splay | gc + standalone | runtime-error | `Error: Key not found: 0.16…` — splay tree keyed by `Math.random()` doubles; lookup after insert misses (numeric key compare / RNG replacement) |
| regexp | gc + standalone | runtime-error | `Cannot access property on null or undefined at 528:24` → regexp.js:136 `Exec(re0, s0[i])` (closure-scoped `s0` from `computeInputVariants`) |
| earley-boyer | gc + standalone | invalid-wasm | `sc_jsNew`: `local.tee[0] expected (ref null N), found local.get of type i32` (earley-boyer.js:1867 — `arguments.length` + direct `eval("new c(…)")`) |
| box2d | gc | invalid-wasm | `__closure_879`: `extern.convert_any[0] expected anyref, found global.get of type i32`; compile 87 s, 1.65 MB |
| box2d | standalone | runtime-error (init) | opaque Wasm exception from top-level code; compile 257 s, 10.9 MB |
| all 9 | linear | compile-error | `Unknown property assignment: .name` (constructor-function `this.x = …` in base.js `Benchmark`) — earley-boyer instead: `Octal escape sequences are not allowed` |

### Candidate follow-up codegen issues (ids to be allocated by the coordinator)

1. **Null check passes, field store traps** — richards gc/standalone and crypto
   standalone (`x == null` reads non-null, the next `x.f = …` / constructor
   sees null). Blocker for the first js2 Octane score (Richards). Planner's
   bisect: `.tmp/octane-probe4.mjs` in the planning worktree.
2. **Invalid Wasm: i32 where a ref is expected** — earley-boyer `sc_jsNew`
   (`local.tee`) and box2d `__closure_879` (`extern.convert_any` on an i32
   global). Validator-level codegen bugs; likely two distinct coercion gaps.
3. **Dynamic prototype methods not callable** — deltablue
   (`Object.defineProperty(Object.prototype, …)` + `inheritsFrom` rewiring).
4. **Closure-captured reassigned `var` reads stale/null** — navier-stokes
   standalone `uiCallback`, regexp `s0` (both lanes), possibly navier-stokes gc.
5. **Module-init throws on raytrace (gc) and box2d (standalone)** — bisect the
   top-level statement; plus a harness-side wish: an export to decode a start-
   function exception (or run top-level code from an exported init function).
6. **splay: `Key not found`** — Math.random-keyed splay tree misses lookups.
7. **crypto gc: no completion in 180 s** — hang vs. pathological slowdown in
   the BigInteger (`am3`, 28-bit digit) path.
8. **raytrace standalone: `__get_builtin` unsupported** — already tracked as
   #1472 Phase B; link, do not duplicate.
9. **linear backend: constructor-function property assignment** (`.name`)
   blocks all nine — a linear-backend scope question, not a bug, until the
   backend claims sloppy constructor functions.
