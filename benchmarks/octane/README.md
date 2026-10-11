# Octane harness (#874)

Runs a DOM-free subset of [Octane v9](https://github.com/chromium/octane)
on node (V8, the 1× reference) and on js2wasm's lanes, with Octane's own
reference constants and validation checks, so a js2 Richards score is directly
comparable to published Octane numbers (e.g. NightMonkey, VMIL 2026: Richards
AOT ~16.4k vs native JIT ~28k; Porffor passes only richards at 1470).

```bash
pnpm run benchmark:octane:fetch        # pinned sources → .octane-cache/<commit>/, SHA256-verified
pnpm run benchmark:octane              # all 9 benches × node, gc, standalone, linear, porffor
pnpm run benchmark:octane -- --only richards,deltablue --lanes node,gc --timeout 300
pnpm run benchmark:octane -- --only richards --tamper   # self-test: must report wrong-result
```

Output: `benchmarks/results/octane-latest.json` + `octane-<timestamp>.json`
(both gitignored; committing a snapshot is a later slice's decision). No CI is
wired to this harness.

## What is fetched, and why nothing is vendored

`fetch.mjs` downloads 11 files from `raw.githubusercontent.com/chromium/octane`
pinned to commit `570ad1ccfe86e3eecba0636c8f932ac08edec517` (Octane is
retired, so the pin is final) and verifies each against the SHA256 in
`manifest.json`; a mismatch deletes the file and exits non-zero. The sources are
mixed BSD-3 / MIT / zlib / **GPL-2** (deltablue), so they are only downloaded and
executed locally, never committed. `manifest.json` records the license per file.

Selected: richards, deltablue, crypto, raytrace, navier-stokes, splay, regexp,
earley-boyer, box2d. Excluded with a reason (printed as `skipped` rows): zlib,
code-load, typescript, pdfjs, mandreel, gbemu — see `manifest.json` `excluded`.

## How a row is produced

`driver.mjs` builds ONE source per bench that every lane consumes:
declared-global shims (`var alert, print, performance`, plus `setupEngine` for
crypto) + `base.js` + the bench file, verbatim + an epilogue exporting
`octane_run(reps)` (lazy Setup once, then `reps` runs of every benchmark in the
suite) and `octane_teardown()`. No benchmark body is edited.

`run.mjs` spawns **one child process per (bench, lane)** with two wall-clock
budgets: `--timeout` (compile + instantiate, default 900 s — box2d's standalone
compile takes ~4.5 min on a loaded 4-vCPU box) and `--run-timeout` (the
measured run after the worker reports it is ready, default 180 s). A killed
worker becomes a `skipped` row whose `reason` names the phase:

| lane | worker | how |
| --- | --- | --- |
| `node` | `worker-node.mjs` | driver as a plain script in a fresh node process; calibrates `reps` so one call ≥ 50 ms |
| `gc` | `worker-js2.mjs` | `compile(src, { allowJs, skipSemanticDiagnostics, validate: false })` + `buildImports` |
| `standalone` | `worker-js2.mjs` | `+ target: "standalone"`; a leaked host import is an `instantiate-error` |
| `linear` | `worker-js2.mjs` | `+ target: "linear"` |
| `porffor` | `worker-porffor.mjs` | `$PORFFOR_DIR/porf` (default `/home/user/porffor`); `skipped` when absent |

The node row's `reps` is passed to every other lane (identical work). Each row
gets exactly one status: `skipped` (with `reason`, incl. timeout) ·
`compile-error` · `invalid-wasm` · `instantiate-error` · `runtime-error` ·
`wrong-result` (a throw matching the bench's Octane validation message) ·
`pass-unvalidated` (box2d: Octane has no check) · `pass`. Only the two pass
states carry timings, so a wrong answer cannot score. Failure rows carry the
error text (Wasm exceptions decoded through the module's `__exn_tag` /
`__exn_render_*` exports) and the driver / `.wasm` paths under `.tmp/octane/`
for reproduction.

## Reading the numbers

- **Score** = `reference[0] / meanUsPerRun × 100` — Octane's formula from the
  mean. **Ratio** = `node.minUsPerRun / lane.minUsPerRun` (min-of-5, as
  `benchmarks/cross-engine`). Deviations from Octane proper are listed in the
  JSON `methodology` field (fixed reps instead of a 1 s window, N=5, splay
  latency not measured, arithmetic mean over the two parts of crypto /
  earley-boyer).
- **Absolute numbers are instance-specific.** The JSON records `uptime` and
  `loadavg`; read the restart-trap paragraph in
  [`../cross-engine/README.md`](../cross-engine/README.md) before comparing two
  runs. Compare lanes within one run only.
- A geomean is printed only over benches that pass on every lane that passes
  anything.

## Latest committed results

Run `2026-10-10T07:28Z`, `pnpm run benchmark:octane` (all defaults), compiler
at `837fdb3105` (no `src/` change in the harness commit; `js2Dirty` in the JSON
only reflects the uncommitted harness files). Machine: 4 vCPU Intel Xeon @
2.80 GHz, 16 GB, node v22.22.0, linux-x64; `uptime` 1:23 at the end of the
run, load average 2.36 / 3.38 / 4.89 — **other agents were working on the box,
so the node scores are noisy** (richards scored between 23.5k and 29.5k across five
runs in this session). Porffor is not installed on this container.

| bench | node (V8) score · mean / min µs per run · reps | js2 gc | js2 standalone | js2 linear | porffor |
| --- | --- | --- | --- | --- | --- |
| richards | **28208** · 125 / 100 · 409 | runtime-error | runtime-error | compile-error | skipped |
| deltablue | **53422** · 124 / 97 · 840 | runtime-error | runtime-error | compile-error | skipped |
| crypto | **15411** · 1727 / 1610 · 22 (×2 parts) | skipped (run timeout 180 s) | runtime-error | compile-error | skipped |
| raytrace | **50199** · 1474 / 1350 · 37 | runtime-error (init) | compile-error | compile-error | skipped |
| navier-stokes | **29594** · 5015 / 4772 · 15 | runtime-error | runtime-error | compile-error | skipped |
| splay | **3955** · 2060 / 1414 · 120 | runtime-error | runtime-error | compile-error | skipped |
| regexp | **6457** · 14108 / 13837 · 4 | runtime-error | runtime-error | compile-error | skipped |
| earley-boyer | **17404** · 3829 / 3379 · 10 (×2 parts) | invalid-wasm | invalid-wasm | compile-error | skipped |
| box2d | **54744** (unvalidated) · 9924 / 7405 · 2 | invalid-wasm | runtime-error (init) | compile-error | skipped |
| zlib, code-load, typescript, pdfjs, mandreel, gbemu | skipped (excluded, see manifest) | skipped | skipped | skipped | skipped |

Node geomean over all 9: **21129**. No js2 lane passes any bench yet, so there is
no js2 score or ratio. Every js2 row's error text, compile time and binary size
are in the JSON and summarised under "Findings" in
`plan/issues/874-benchmark-compare-all-js-to.md`.
