---
id: 3622
title: "Unbounded runtime scan: `Array.prototype.lastIndexOf` on an array-like never matches at indices > 2^32, so it walks ~9×10^15 slots (in-process harnesses hang forever)"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: hard
goal: core-semantics
created: 2026-07-25
related: [1589, 3592]
---

## ⚠ Read this first: a skip list that guards nothing

`tests/test262-runner.ts` `HANGING_TESTS` **appears** to cover this whole family. It
does not. The three #1589A entries are **dead keys** that can never match — see
"Secondary finding" below. Nothing but the compiler-pool `SIGKILL` stands between the
corpus run and an unbounded loop, and any harness that does not fork per test has no
protection at all. A skip list that looks like it covers something it doesn't is the
more dangerous half of this issue.

## Summary

`test/built-ins/Array/prototype/lastIndexOf/length-near-integer-limit.js` sends the
**executed Wasm** into an effectively unbounded loop. One worker of the #3592 RC2 A/B
sweep sat on this single file for **3 h 40 m at 99.8 % CPU, `state=R`, 1.25 GB RSS**
before it was killed.

This is a **real compiler/runtime defect, independent of the #3592 measurement** — an
input that sends the emitted program into an unbounded loop while producing a silently
wrong answer for every smaller-but-still-large index.

## The phase is EXECUTION, not compilation (measured)

The initial report assumed "the compile is synchronous and CPU-bound, so a timeout
cannot interrupt it". **That premise is wrong.** Measured on `main`
(`c429f780042586`), standalone target, production worker compile options
(`scripts/test262-worker.mjs:1144` — `allowJs`, `skipSemanticDiagnostics`,
`target: "standalone"`):

| variant (identical source shape, `length: Number.MAX_SAFE_INTEGER` in all three) | compile | instantiate + run |
| --- | --- | --- |
| upstream file (`fromIndex = MAX_SAFE_INTEGER-1`, `elIndex = MAX_SAFE_INTEGER-3`) | **578 ms**, 114,133 bytes | **never returns** (killed at 120 s; original observation 3 h 40 m) |
| `fromIndex = MAX_SAFE_INTEGER-2` == `elIndex` (match on the FIRST iteration) | 1,936 ms | **never returns** |
| `fromIndex = 5`, `elIndex = 3` | 3,828 ms | **6 ms** |

Compilation completes in ~0.6–3.8 s in *every* variant. Only the executed module
diverges, and it diverges as a function of `fromIndex` — a runtime iteration count, not
a source-shape property. So the runaway is in the emitted Wasm, not in the compiler.

## Root cause (narrowed)

Row 2 of that table is the decisive one. With `fromIndex === elIndex` the spec
algorithm matches on its **first** iteration, so a correct implementation returns
immediately regardless of how large the index is. It still hangs. Therefore:

> the property lookup for a large integer index does not resolve — the element stored
> by `arrayLike[9007199254740988] = el` is not found when read back at that index.

Because the search never matches, the loop walks every index from `fromIndex` down
towards 0 — ~9×10^15 iterations. RSS growth (→1.25 GB) is the loop's allocation
churn, not a compile-time blowup.

This is the same root cause already recorded for the sibling family in
`tests/test262-runner.ts` `HANGING_TESTS` (#1589 "Hot spot A"):

> `Array.prototype.{indexOf,lastIndexOf}.call(obj, …)` with `length: 4294967296`.
> Wrong object-literal field-type inference (empty `{}` treated as `Test262Error`) +
> `__extern_has_idx` returning 0 for null payload causes a 4-billion-iteration search
> loop → 30 s timeout.

This file is the same bug with `length: Number.MAX_SAFE_INTEGER` — ~2×10^6 times more
iterations, which is why it reads as a permanent hang rather than a 30 s timeout.
The likely mechanism is an i32-width index path (`__extern_has_idx` / the indexed
read) that cannot address indices ≥ 2^32.

## Reproduce

```bash
# in a worktree at main, after building the bundles:
node_modules/.bin/esbuild src/index.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen

# compile-only + instantiate, phase-separated (the probe used above):
timeout -s KILL 120 node .tmp/hang-phase.mjs \
  test262/test/built-ins/Array/prototype/lastIndexOf/length-near-integer-limit.js
# → COMPILE_DONE ms=578 ... bytes=114133
# → INSTANTIATE_START            (never reaches INSTANTIATE_DONE)

# control — same source, small fromIndex:
timeout -s KILL 100 node .tmp/hang-phase.mjs \
  test262/test/built-ins/Array/prototype/lastIndexOf/length-near-integer-limit.js 5 3
# → INSTANTIATE_DONE ms=6
```

Through the production runner (this one terminates — see next section):

```bash
TEST262_TARGET=standalone \
TEST262_PATH_FILTER="Array/prototype/lastIndexOf/length-near-integer-limit.js" \
COMPILER_POOL_SIZE=2 \
node node_modules/vitest/dist/cli.js run tests/test262-local-shard*.test.ts --reporter=basic
# → ConformanceError: [compile_timeout] timeout (10s)   (whole probe: 65 s)
```

## Why the production runner does NOT hang on the full corpus — the fix template

The full-corpus `pnpm run test:262` completes because of **process isolation +
SIGKILL**, not because the test is skipped:

- `tests/test262-shared.ts` sends every test to a **unified fork pool**
  (`scripts/compiler-pool.ts`) that *compiles and executes* in a forked child.
- `scripts/compiler-pool.ts:277-297` arms a `setTimeout(job.timeoutMs)` once a fork
  accepts the job; on expiry it records `status: "compile_timeout"` and calls
  `free.proc.kill("SIGKILL")` on the specific worker running it.
- A runaway is therefore bounded at 30 s (`runTest` default) + the #1589 serial retry
  at 10 s, and the pool respawns the fork. The recorded status reads
  `[compile_timeout] timeout (10s)`, but per the table above the time is spent in
  **execution**, so that label is a misnomer for this class.

Any in-process harness (anything calling `runTest262File` directly, like the bespoke
A/B worker that hung) has **no** such bound: a synchronous Wasm loop cannot be
preempted by a JS-level timer in the same process. The template for such harnesses is
the pool's model — run each file in a child process and SIGKILL on the wall clock.

### Secondary finding: the `HANGING_TESTS` entries for this family are DEAD KEYS

`tests/test262-runner.ts` looks the test up with the `test262/` prefix stripped, which
**leaves the `test/` segment in the key**:

```ts
const relTest = filePath.replace(/.*test262\//, "");   // → "test/built-ins/Array/..."
if (HANGING_TESTS.has(relTest)) { ... }
```

but the #1589A entries are stored prefix-less:

```ts
"built-ins/Array/prototype/indexOf/15.4.4.14-3-28.js",
"built-ins/Array/prototype/indexOf/15.4.4.14-3-29.js",
"built-ins/Array/prototype/lastIndexOf/15.4.4.15-3-28.js",
```

so `HANGING_TESTS.has(...)` is **always false** for them. The in-source note dated
2026-07-09 already observed this for `S7.4_A6.js` and chose to leave the stale keys
alone (activating them would flip a now-passing test to `skip`). Consequence: the skip
list is **not** what protects the corpus run — only the pool SIGKILL is. Do not treat
`HANGING_TESTS` as a working guard when reasoning about hangs.

## Acceptance criteria

1. `Array.prototype.lastIndexOf.call(arrayLike, el, fromIndex)` finds an element stored
   at an index ≥ 2^32 (i.e. the read path addresses the full safe-integer index range),
   so `length-near-integer-limit.js` terminates in ~3 iterations and passes.
2. The same holds for `indexOf` (`15.4.4.14-3-28.js` / `-29.js`) and
   `lastIndexOf/15.4.4.15-3-28.js` — the `length: 4294967296` siblings.
3. Either fix the `HANGING_TESTS` keys for those three (add the `test/` prefix) or
   delete them as dead, with the reasoning recorded — the current state silently
   pretends to guard something it does not.

## Notes for whoever picks this up

- Do **not** start by chasing the loop bound. The loop is a *symptom*; the defect is
  the failed large-index property read. Fix the read and the loop terminates on
  iteration 1 for the upstream file.
- The `{ length: Number.MAX_SAFE_INTEGER }` object literal's field-type inference is
  the other half of the #1589A note (empty `{}` inferred as `Test262Error`); check
  whether that is still true on current `main` before assuming it.
- `feasibility: hard` because the fix touches the indexed-property read path
  (`__extern_has_idx` and friends) where an i32→i64/f64 index widening has value-rep
  and codegen consequences well beyond these four tests.
