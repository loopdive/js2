---
id: 3908
title: "linear backend: array/find emits an invalid module — local.set[0] expected i32, found local.get of type f64"
status: done
created: 2026-07-31
updated: 2026-08-18
completed: 2026-07-31
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen-linear
language_feature: array-methods
goal: performance
sprint: 78
horizon: m
es_edition: multi
related: [3902, 3904]
---

# #3908 — `array/find` linear-memory lane fails Wasm validation

## Status: FIXED (2026-07-31)

## Problem

The linear-memory lane of the `array/find` benchmark emits a module that
fails validation at instantiation:

```
WebAssembly.instantiate(): Compiling function #50:"run" failed:
local.set[0] expected type i32, found local.get of type f64
```

Repro:

```bash
npx tsx benchmarks/run.ts --suite arrays --filter find
```

An f64 value is flowing into an i32 local slot in the linear backend's
lowering. It reproduces on `main` today.

## Why it was invisible until now

`benchmarks/harness.ts` silently downgraded any failing strategy to a skip and
dropped the row entirely, so a broken lane was indistinguishable from a lane
that was deliberately not applicable. #3904 changed that: failed strategies are
now recorded with `status: "failed"` and their error.

**Consequence: once #3904 lands, this becomes a visible `FAILED` bar on the
public performance page.** Better to fix it before then than to explain it
after.

## Scope

1. Find the f64→i32 slot mismatch in `src/codegen-linear/`. The callback-shaped
   `find` lowering is the obvious suspect — the predicate returns a boolean but
   the element is a `number`, so a slot is probably being reused across two
   types.
2. **Sweep the other suites' linear lanes.** The same mismatch is unlikely to
   be unique to `array/find`. Note that the linear lane currently produces
   results for only 2 of 28 benchmarks (`mixed/fibonacci`,
   `mixed/matrix-multiply`) — the other 26 are absent, and until #3904 lands we
   cannot tell which are legitimately skipped and which are failing like this
   one. Re-run after #3904 to get the real inventory, and report it here.
3. Add a validation regression test for whatever shape is at fault.

## Acceptance criteria

1. `array/find`'s linear-memory lane produces a valid module and a real number.
2. The issue reports how many of the 26 currently-absent linear lanes are
   failures vs. deliberate skips, measured after #3904 lands.
3. A regression test covers the faulty lowering shape.

## Root cause

`compileArrayHOF` in `src/codegen-linear/index.ts` (the inline expansion of
`filter`/`map`/`some`/`find`/`flatMap`) computes an `elemType` for the
callback's element local — `f64` for `number[]`/`boolean[]`, `i32` (pointer)
otherwise. It then allocated `find`'s result accumulator with a **hard-coded
`{ kind: "i32" }`**, ignoring `elemType`. On a numeric array that mismatch broke
the module at *both* ends of the lowering:

- inside the loop, the "found" branch emits `local.get <elem:f64>` /
  `local.set <result:i32>`;
- after the loop the accumulator is pushed as the call's value, and the caller
  stores it into an `f64` local — `inferExprType` resolves `arr.find(...)` via
  the checker to `number | undefined` → non-nullable `number` → `f64`.

Confirmed by reading the emitted WAT: `(local $__hof_result_10 i32)` sitting
between `(local $x f64)` and `(local $found f64)`.

The `find` "not found" sentinel was likewise a hard-coded `i32.const 0`, which
is the same defect on the initialization path.

**Fix**: `find`'s accumulator takes `elemType`, and its sentinel is
`f64.const 0` for an f64 slot / `i32.const 0` for a pointer slot. The `0`
sentinel value is unchanged, so the existing `found !== undefined` → `f64.ne 0`
lowering keeps working. `filter`/`map`/`flatMap` (i32 array pointer) and `some`
(f64 boolean) are unaffected.

Regression test: `tests/issue-3908.test.ts` (6 cases; 5 of them fail against
the pre-fix compiler, the 6th is the i32/reference-element no-regression
guard).

## Linear-lane inventory (acceptance criterion 2)

Measured 2026-07-31 on this branch, with #3904's failure-recording merged in.
28 benchmarks total; each linear lane compiled, instantiated, and driven for
`warmup + iterations` calls (a 1-shot call under-reports — several lanes only
trap once the arena fills).

| Bucket | Count |
| --- | ---: |
| Working (measured) | **3** |
| Deliberate skip (`def.skip`) | **4** |
| Compile error — unimplemented method | **16** |
| Runtime trap — `memory access out of bounds` | **5** |

Of the **26 previously-absent** lanes: **4 are deliberate skips and 22 are real
failures** (16 compile errors + 5 runtime traps + `array/find`, which this issue
fixes). "2 of 28 produce results" is now 3 of 28.

**Working (3)**: `array/find` (fixed here — returns 500000, correct),
`mixed/fibonacci`, `mixed/matrix-multiply`.

**Deliberate skips (4)** — all `dom/*`: `create-elements`, `set-attributes`,
`read-attributes`, `modify-text`. These declare `skip: ["linear-memory"]`; the
linear lane has no host/DOM boundary. Legitimate.

**Compile errors (16)** — every one is `Unsupported method call` /
`Unsupported Array method`, i.e. a *missing builtin* in the linear lane, not a
miscompile:

| Missing method | Benchmarks |
| --- | --- |
| `String.repeat` | `string/concat-long`, `string/indexOf`, `string/includes` |
| `String.replace` | `string/replace` |
| `String.toLowerCase`/`toUpperCase` | `string/case-convert` |
| `String.substring` | `string/substring` |
| `String.trim` | `string/trim` |
| `String.endsWith` | `string/startsWith-endsWith` |
| `String.includes`/`endsWith` | `mixed/text-search` |
| `Array.pop` | `array/push-pop` |
| `Array.sort` | `array/sort-i32` |
| `Array.reduce` | `array/reduce` |
| `Array.indexOf` | `array/indexOf` |
| `Array.slice` | `array/slice` |
| `Array.reverse` | `array/reverse` |
| `Array.forEach` | `array/forEach` |

(Note `string/indexOf` and `string/includes` are blocked by `.repeat()` in
their *setup*, so their nominal subject may also be unimplemented — `includes`
demonstrably is.)

**Runtime traps (5)** — all `memory access out of bounds`, and a controlled
experiment shows **4 of the 5 are one root cause**: the linear lane's bump
arena never reclaims, and the benchmark harness invokes `run()` repeatedly
without resetting it. Recompiling with `allocator: "arena-reset"` and calling
`__arena_reset()` between invocations makes them all pass with correct values:

| Benchmark | no reset | with `__arena_reset()` |
| --- | --- | --- |
| `string/split` | trap after 4/55 | OK — `80000` |
| `array/map-filter` | trap after 28/55 | OK — `3334` |
| `mixed/csv-parse` | trap after 6/25 | OK — `30000` |
| `mixed/sieve` | trap after 7/25 | OK — `9592` |
| `string/concat-short` | trap after 0/55 | **still traps after 0/55** |

`string/concat-short` is therefore a *distinct* defect: it traps on the very
first call, because `s = s + "hello world!!!!"` × 10,000 allocates the
quadratic ~1.5 GB of intermediate strings *within* one call. A between-call
reset cannot help; that needs intra-call reclaim or a rope/builder string
representation.

### Follow-ups to file (not fixed here)

1. **Linear lane's missing String builtins** — `repeat`, `replace`,
   `toLowerCase`/`toUpperCase`, `substring`, `trim`, `endsWith`, `includes`
   (7 benchmarks blocked).
2. **Linear lane's missing Array builtins** — `pop`, `sort`, `reduce`,
   `indexOf`, `slice`, `reverse`, `forEach` (7 benchmarks blocked).
3. **Bump arena is never reclaimed across harness invocations** — 4 benchmarks
   trap purely from arena exhaustion and pass with `__arena_reset()`. Either
   the benchmark harness should compile the linear lane with
   `allocator: "arena-reset"` and rewind between calls, or the lane needs an
   automatic reclaim policy.
4. **Quadratic intra-call string allocation** (`string/concat-short`) — traps
   inside a single call; not fixable by a between-call reset.

None of these is another instance of the f64→i32 slot mismatch; #3908's shape
appears to be unique to `find`'s accumulator (`filter`/`map`/`flatMap` allocate
an array pointer and `some` a boolean, both of which already matched).

## Notes

- Found by `issue-3902-array-sort` while un-skipping `array/find`'s gc-native
  lane, and independently reproduced by `issue-3904-dom-lane`. Neither touched
  the linear backend; it is a pre-existing defect in both cases.
- Per `docs/architecture/codegen-axes.md`, the linear backend is not superseded
  by WasmGC — both stay. So this is a real gap, not dead code.
- Pre-existing, unrelated: `tests/issue-3497-linear-jsdoc-landing-signatures.ts`
  has one failing case on this branch's base; it fails identically with and
  without this fix.
