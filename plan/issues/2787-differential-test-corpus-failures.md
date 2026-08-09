---
id: 2787
title: "Differential-test corpus failures — 2 malformed_wasm + 13 mismatch + 6 runtime_error"
status: done
completed: 2026-07-23
sprint: Backlog
created: 2026-06-28
updated: 2026-07-19
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: conformance
language_feature: compiler-internals
goal: trustworthiness
related: [389, 2143, 1941]
origin: "2026-06-28 — diff-test red on main (job 83903650345, surfaced in #2252 merge_group); reply to loopdive/js2#389"
---

# #2787 — Differential-test corpus failures (umbrella tracking)

## Problem

The `diff-test` ("Differential test", `scripts/diff-test.ts`, corpus
`tests/differential/corpus`, 104 programs) is a **non-required** gate that
compares js2wasm output against the V8 reference engine (Node-host lane:
in-process `compile()` → `WebAssembly.validate` → instantiate → compare
stdout). It is currently **red on main**.

The redness was surfaced in **#2252's `merge_group`** — a pure dependency
**version bump** with no codegen change — so these failures are
**pre-existing**, not release-caused. In that run the corpus actually
**net-improved** (baseline 69/104 → current 83/104 match, 15 improvements);
the delta gate failed on a **single new regression**
(`array/01-basic.js: match → malformed_wasm`). This umbrella issue catalogs
the full failing set so it can be triaged down over time.

Source of truth for the list below: CI job **83903650345**
(`gh run view --job 83903650345 -R loopdive/js2 --log`). The default lane and
the `-O3` optimize lane show the **same** 21 failures, so none is
wasm-opt-specific.

## Failure buckets (21 failing programs of 104)

### Bucket A — `malformed_wasm` (2) — INVALID output, highest severity

The compiler reports `success` but `WebAssembly.validate` **rejects** the
binary — a genuine codegen correctness bug (the module won't load on a strict
engine at all). **Tracked separately and at higher priority in #2788**
(`area: codegen`, `sprint: current`, `priority: high`) with reproduced
validator errors.

- `array/01-basic.js` — **new regression** this run (`match → malformed_wasm`);
  `__module_init` type mismatch: `call[0] expected type f64, found if of type externref`
- `closures/10-mutual.js` — already malformed on the baseline;
  `__module_init` type mismatch: `call[0] expected type externref, found call of type i32`

### Bucket B — `mismatch` (13) — VALID wasm, wrong output (conformance divergence)

The binary validates and runs but produces output that differs from V8:

- `array/12-from-of.js`
- `builtins/01-json-stringify.js`
- `builtins/04-symbol.js`
- `builtins/07-promise-basic.js`
- `builtins/08-promise-chain.js`
- `builtins/09-async-await.js`
- `classes/10-toString-impl.js`
- `closures/07-arrow-this.js`
- `closures/09-callback.js`
- `control/12-for-in-object.js`
- `object/02-spread.js`
- `object/06-delete.js`
- `object/12-assign.js`

### Bucket C — `runtime_error` (6) — VALID wasm, traps/throws at instantiate

The binary validates but throws during instantiation/execution:

- `array/11-flat-flatMap.js`
- `builtins/03-map-set.js`
- `builtins/12-arraybuffer.js`
- `builtins/14-spread-args.js`
- `builtins/15-tag-template.js`
- `closures/08-method-chain.js`

## Severity ordering

1. **Bucket A (malformed_wasm)** — real invalid-module codegen bugs. Higher
   severity than a wrong-output mismatch because the module is not even
   well-formed. Owned by **#2788**.
2. **Buckets B + C** — conformance divergences on valid wasm. Lower severity
   (the module is well-formed); these are feature-completeness gaps in
   Promise/async, Map/Set, Symbol, spread, JSON.stringify, delete, for-in,
   arrow-`this`, tagged templates, ArrayBuffer, etc. Several likely already
   have feature-specific issues.

## Acceptance criteria

- Bucket A driven to zero via #2788 (so the diff-test delta gate goes green
  again w.r.t. the `array/01-basic.js` regression).
- Buckets B/C triaged: each mapped to an existing feature issue or a new
  per-feature follow-up; the corpus baseline reflects intended state.

## Notes

- Relation to **#2143**: that issue added the `WebAssembly.validate` lane to
  the default pipeline so malformed*wasm is \_caught*; this issue is about
  _fixing_ the programs it surfaces.
- Relation to **#1941**: the optimize lane / corpus work.
- Relation to **loopdive/js2#389**: the external reporter's `--target wasi`
  output is **valid WasmGC** (verified — the `-0x9` `wasm-validate` error is
  an old-wabt limitation, not a js2wasm bug); that is unrelated to these
  diff-test codegen failures, which are on the default WasmGC + JS-host path.

---

## Harness fix (2026-07-19) — async side-effect capture (corpus 96→99 match)

**Root cause (harness, not compiler):** the js2wasm lane in `scripts/diff-test.ts`
restored the monkey-patched `console.log` in its `finally` block *immediately*
after calling `__module_init()`. Corpus programs that schedule callbacks via
`Promise.resolve().then(...)` / `async`/`await` invoke the host `console.log`
import **after** `__module_init()` returns — i.e. after the capture window had
already been torn down. Consequences: (1) those late writes leaked to the real
stdout (the stray `42` / `4` / `30` lines seen in harness output), and (2) the
program recorded **empty** output → a false `mismatch` against the V8 oracle,
which runs the full job queue before exiting.

This directly contradicts the 2026-07-06 note's claim that promise output "stayed
empty even after a 50ms + microtask drain": draining the microtask + macrotask
job queue **before** restoring `console.log` captures the output verbatim. The
compiler's Promise/async lowering works for these programs; only the harness was
dropping the async output.

**Fix:** `runJs2wasm` now awaits `drainAsync()` (bounded microtask + `setTimeout(0)`
macrotask drain) inside the capture window before restoring `console.log`. This
flips three programs from false `mismatch` to `match` and eliminates the stdout
pollution:

- `builtins/07-promise-basic.js` — now captures `42` (#1042 cluster — not a gap)
- `builtins/08-promise-chain.js` — now captures `4`
- `builtins/09-async-await.js` — now captures `30`

Corpus: **96 → 99 / 104 match** (3 mismatch, 2 runtime_error, 0 malformed_wasm).
The committed `diff-test-baseline.json` is refreshed to this state so the delta
gate now protects these three programs from regressing back to empty output.
Scoped regression test: `tests/issue-2787.test.ts`. `runJs2wasm` is now exported
and `main()` is guarded behind an entry-point check so the test can import it
without triggering a full corpus run.

The remaining 5 failing programs (`array/12-from-of`, `closures/07-arrow-this`,
`object/06-delete` mismatches; `builtins/14-spread-args`,
`closures/08-method-chain` runtime_errors) are genuine substrate-level compiler
gaps tracked by #2796/#2797, correctly deferred — no harness or cheap localized
fix applies.

## Re-measure (2026-07-06) — corpus improved 20→9 failing

Re-ran `scripts/diff-test.ts` against current `upstream/main`
(`07ad889185`). **Current set: 95 match / 7 mismatch / 2 runtime_error /
0 malformed_wasm** — down from the 20 failing catalogued in the
2026-06-28 triage below. The following 2026-06-28 entries now **pass** and
are resolved by intervening work: `builtins/01-json-stringify`,
`builtins/03-map-set`, `builtins/12-arraybuffer`, `builtins/15-tag-template`,
`array/11-flat-flatMap`, `control/12-for-in-object`, `object/02-spread`,
`object/12-assign`, `closures/09-callback`, `classes/10-toString-impl`, and
`closures/10-mutual` (booleans now render `true`/`false` correctly at the
`console.log` boundary — the stale "renders as 1" note no longer holds).

**Remaining 9 failing — each maps to an open feature cluster (all
substrate-level, no cheap localized codegen fix available):**

| program                     | kind          | cluster / target issue                                                                                                    |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `builtins/04-symbol`        | mismatch      | #2795 — value→string rendering (`Symbol.prototype.toString`)                                                               |
| `object/06-delete`          | mismatch      | #2796 — object literal is a fixed nominal struct; `delete o.a` can't drop a struct field (needs dynamic property bag)      |
| `array/12-from-of`          | mismatch      | #2796 — `Array.from({length:3}, mapFn)` array-like host interop: native `Array.from` reads the wasm struct `.length` as 0 |
| `closures/07-arrow-this`    | mismatch      | #2797 — arrow lexical `this` via `.call({})` → NaN                                                                         |
| `builtins/07-promise-basic` | mismatch      | #1042 — Promise `.then` callback never runs                                                                                |
| `builtins/08-promise-chain` | mismatch      | #1042 — promise chain callbacks never run                                                                                  |
| `builtins/09-async-await`   | mismatch      | #1042 — `await`/async no-op → empty                                                                                        |
| `builtins/14-spread-args`   | runtime_error | #2797 — `f(...arr)` / `Math.max(...arr)` illegal cast                                                                      |
| `closures/08-method-chain`  | runtime_error | #2797 — dynamic method dispatch on returned object literal traps                                                           |

Mechanisms pinned this pass (measure-first): `object/06-delete` — the object
literal `{a:1,b:2}` lowers to a nominal struct with fixed fields, so
`__delete_property` cannot remove `a` and `Object.keys` still enumerates it
(`["a,b","1"]` vs V8 `["b","undefined"]`); `array/12-from-of` — `__array_from`
(src/runtime.ts) hands the raw wasm array-like struct to native `Array.from`,
which reads `.length` as 0 (no dynamic-reader bridge for the array-like host
path). Both are #2796/#2797 substrate items, correctly deferred — no cheap
floor-visible slice remains in the corpus (the earlier cheap wins — the ANSI
harness fix and the two `malformed_wasm` cases — already landed).

## Triage (2026-06-28) — full A/B/C classification + fix plan

Re-ran `scripts/diff-test.ts` against current main. **Current set: 84 match /
14 mismatch / 6 runtime_error / 0 malformed_wasm** (the 2 malformed cases —
`array/01-basic.js`, `closures/10-mutual.js` — were fixed by #2259/#2788;
`closures/10-mutual` now validates and is a `mismatch` instead).

### (B) Harness quirk found + fixed inline — ANSI colour pollution

The diff-test reference lane spawned `node <file>` **inheriting the
environment**, and this dev container exports `FORCE_COLOR=3`, so Node
colourises `console.log` output (`\x1b[33m42\x1b[39m`) even when stdout is
piped. `normalize()` did not strip ANSI, so the V8 reference mismatched the
plain js2wasm lane on **virtually every numeric/string program — 69 spurious
mismatches locally** (CI doesn't set FORCE_COLOR, so it saw the true 14). This
is a **harness-robustness bug, not a compiler bug**. Fixed in this PR:
`runV8` now spawns with `FORCE_COLOR=0 NO_COLOR=1`, and `normalize()` strips
ANSI SGR codes as belt-and-suspenders. After the fix the local run matches CI
(84/14/6) regardless of the ambient colour env.

### (A) Real js2wasm bugs — 20 programs, grouped into clusters

All 20 remaining failures are genuine compiler gaps. Notably, **most map to
feature issues already marked `done`** — yet they fail in the idiomatic-untyped
default host path the corpus exercises (object literals as dynamic bags,
untyped arrows). This is exactly the value differential testing (#1203) adds
over test262: the "done" features were validated on narrower/typed shapes.
**PO action: confirm regression vs current main and reopen the cited `done`
issues where warranted.**

| #   | program                    | kind          | root cause                                                                        | A/B/C | cluster / target issue                                         |
| --- | -------------------------- | ------------- | --------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------- |
| 1   | classes/10-toString-impl   | mismatch      | `""+obj` / `${obj}` ignore user `toString()` → `[object Object]`                  | A     | **NEW #2795** (value→string rendering)                         |
| 2   | builtins/04-symbol         | mismatch      | `Symbol.prototype.toString()` → `[object Object]`                                 | A     | **NEW #2795**                                                  |
| 3   | closures/10-mutual         | mismatch      | boolean renders as `1` not `true` at console.log boundary                         | A     | **NEW #2795**                                                  |
| 4   | control/12-for-in-object   | mismatch      | `for..in` over object yields no keys                                              | A     | **NEW #2796** (dyn-object enum/copy); rel #1243/#1271 (done)   |
| 5   | object/02-spread           | mismatch      | `{...a}` wrong key order + values read back NaN                                   | A     | **NEW #2796**                                                  |
| 6   | object/12-assign           | mismatch      | `Object.assign` copies no own keys (identity ok)                                  | A     | **NEW #2796**; rel #1336/#1630 (done)                          |
| 7   | closures/07-arrow-this     | mismatch      | arrow lexical `this` via `.call({})` → NaN                                        | A     | **NEW #2797** (untyped arrow/closure dispatch); rel #11 (done) |
| 8   | closures/09-callback       | mismatch      | arrow through untyped fn param drops return value → empty                         | A     | **NEW #2797**                                                  |
| 9   | closures/08-method-chain   | runtime_error | dynamic method dispatch on returned object literal traps (WebAssembly.Exception)  | A     | **NEW #2797**; rel #1382 (done)                                |
| 10  | builtins/07-promise-basic  | mismatch      | `Promise.resolve().then()` callback never runs (empty even after microtask drain) | A     | #1042 async/await (backlog); rel #1014                         |
| 11  | builtins/08-promise-chain  | mismatch      | promise chain `.then` callbacks never run                                         | A     | #1042 (backlog)                                                |
| 12  | builtins/09-async-await    | mismatch      | `await`/async no-op → empty output                                                | A     | #1042 (backlog)                                                |
| 13  | builtins/01-json-stringify | mismatch      | `JSON.stringify(obj)` / `(array)` → `undefined` (primitives ok)                   | A     | #1324 JSON.stringify (done) — re-verify host path              |
| 14  | array/11-flat-flatMap      | runtime_error | `arr.flat`/`flatMap` not a function                                               | A     | #1136 flat/flatMap (done) — re-verify host path                |
| 15  | array/12-from-of           | mismatch      | `Array.from(arrayLike, mapFn)` 2-arg form missing (Array.of/from(string) ok)      | A     | #1160 Array.from (done) — re-verify                            |
| 16  | builtins/03-map-set        | runtime_error | `new Set([...])` — source not iterable (Symbol.iterator)                          | A     | #1514 Set (done) / iterator protocol — re-verify               |
| 17  | builtins/12-arraybuffer    | runtime_error | `DataView.setInt32` not a function                                                | A     | #1056 DataView setIntN (done) — re-verify                      |
| 18  | builtins/14-spread-args    | runtime_error | `f(...arr)` / `Math.max(...arr)` → illegal cast                                   | A     | #1519 spread (done) — re-verify call-arg spread                |
| 19  | builtins/15-tag-template   | runtime_error | tagged template — `strs.join` not a function (strings array lacks proto methods)  | A     | #109 tagged templates (done) — re-verify                       |
| 20  | object/06-delete           | mismatch      | `delete o.a` does not remove the property                                         | A     | #1112 delete-via-sentinel (done) / #124 (wont-fix) — re-verify |

### (C) Known-deferred — none

No `eval`/`Proxy`/`with`/Temporal/SharedArrayBuffer programs in the failing set,
so there is nothing to corpus-exclude as intentionally-unsupported.

### Prioritized fix plan (cheap + high-value first)

1. **#2795 — value→string rendering (toString/@@toPrimitive + boolean)** —
   `current`, **P1**, ~M. Highest value/cost ratio: one coercion site, 3 corpus
   programs, broad test262 ToString/ToPrimitive overlap. Do first.
2. **#2796 — dynamic-object own-key enumerate/copy (for-in, spread, assign)** —
   `current`, **P1**, ~M. Core ES2015 idioms; likely one shared property-bag
   iterate+read primitive flips all 3.
3. **Re-verify the "done"-but-failing builtins** (#1324 JSON.stringify-object,
   #1136 flat/flatMap, #1160 Array.from(arrayLike,mapFn), #1056 DataView.setInt32,
   #109 tagged-template `.join`, #1514 Map/Set-from-iterable, #1519 call-arg
   spread, #1112 delete). These are **single-feature regressions/host-gaps** — PO
   should reopen each (or file a focused follow-up) rather than re-file from
   scratch; many are likely small "method not registered on host prototype" or
   "host-mode path not wired" fixes. Cost: low-to-medium each; high cumulative
   value (8 programs).
4. **#1042 — async/await + Promise.then** — `backlog`, larger. Promise callbacks
   never run (confirmed empty even after a 50ms + microtask drain, so NOT a
   harness drain bug). State-machine lowering; defer behind the cheap wins.
5. **#2797 — untyped arrow/closure + dynamic method dispatch** — `Backlog`,
   **feasibility: hard**. Touches the `any`-receiver / funcref substrate; may
   need an architect spec. Lowest priority of the new clusters.

Cost summary: #2795 + #2796 (the two `current` clusters) are the cheap,
high-value front — both ~M, both likely a single shared primitive each. The
"done-but-failing" re-verifications are a PO reopening sweep. #1042 and #2797
are the genuinely larger items, correctly deferred to backlog.
